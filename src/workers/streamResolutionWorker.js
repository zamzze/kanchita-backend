'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const pool = require('../config/db');
const {
  createResolutionQueue,
  safeErrorCode,
} = require('../modules/streams/resolutionQueue');
const { createStreamProcessor } = require('../modules/streams/streamProcessor');
const { createWorkerHeartbeatStore } = require('../modules/streams/workerHeartbeat');
const { createStreamPrewarm } = require('../modules/streams/streamPrewarm');
const { createStreamLifecycle } = require('../modules/streams/streamLifecycle');
const { createHlsValidator } = require('../modules/streams/hlsValidator');
const { redactSensitive } = require('../utils/redact');
const {
  STREAM_WORKER_POLL_MS,
  STREAM_JOB_LEASE_SECONDS,
  STREAM_JOB_MAX_ATTEMPTS,
  STREAM_RESOLUTION_TIMEOUT_MS,
  STREAM_RESOLVER_KILL_GRACE_MS,
  STREAM_PREWARM_BATCH_SIZE,
  STREAM_REFRESH_AHEAD_MINUTES,
  STREAM_WORKER_HEARTBEAT_SECONDS,
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
} = require('../config/env');

const MIN_LEASE_MARGIN_MS = 30_000;

const createWorkerId = () =>
  `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const createStreamWorker = ({
  queue = createResolutionQueue(pool, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS }),
  processor,
  heartbeat = null,
  prewarm = null,
  prewarmIntervalMs = 60_000,
  logger = console,
  sleep = delay,
  workerId = createWorkerId(),
  pollMs = STREAM_WORKER_POLL_MS,
  leaseSeconds = STREAM_JOB_LEASE_SECONDS,
  resolutionTimeoutMs = STREAM_RESOLUTION_TIMEOUT_MS,
  resolverKillGraceMs = STREAM_RESOLVER_KILL_GRACE_MS,
  heartbeatIntervalMs = STREAM_WORKER_HEARTBEAT_SECONDS * 1000,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) => {
  const activeProcessor = processor || createStreamProcessor({ db: pool, workerId });
  if (leaseSeconds * 1000 < resolutionTimeoutMs + resolverKillGraceMs + MIN_LEASE_MARGIN_MS) {
    throw new Error(
      'STREAM_JOB_LEASE_SECONDS must exceed resolver timeout + kill grace by at least 30 seconds'
    );
  }
  let stopping = false;
  let activeJobPromise = null;
  let nextPrewarmAt = 0;
  let activeJobId = null;
  let heartbeatTimer = null;
  let jobLeaseTimer = null;

  const runPrewarmIfDue = async () => {
    if (!prewarm || Date.now() < nextPrewarmAt) return;
    nextPrewarmAt = Date.now() + prewarmIntervalMs;
    await prewarm.runBatch();
  };

  const processClaimedJob = async (job) => {
    const renewalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3));
    jobLeaseTimer = setTimer(() => {
      queue.renewJobLease(job.id, workerId).catch(() => {});
    }, renewalMs);
    jobLeaseTimer.unref?.();
    try {
      await activeProcessor(job);
      await queue.completeJob(job.id, workerId);
      logger.log('[StreamWorker] job completed');
    } catch (error) {
      const code = safeErrorCode(error?.code);
      await queue.failJob(job.id, workerId, code);
      logger.warn(`[StreamWorker] job failed: ${code}`);
    } finally {
      clearTimer(jobLeaseTimer);
      jobLeaseTimer = null;
    }
  };

  const runOnce = async () => {
    if (stopping || activeJobPromise) return false;
    await heartbeat?.beat(workerId, null);
    await runPrewarmIfDue();
    await queue.recoverStaleJobs(leaseSeconds);
    if (stopping) return false;

    const job = await queue.claimNextJob(workerId);
    if (!job) return false;

    activeJobId = job.id;
    await heartbeat?.beat(workerId, activeJobId);
    activeJobPromise = processClaimedJob(job);
    try {
      await activeJobPromise;
    } finally {
      activeJobPromise = null;
      activeJobId = null;
      await heartbeat?.beat(workerId, null);
    }
    return true;
  };

  const start = async () => {
    await heartbeat?.start(workerId);
    if (heartbeat) {
      heartbeatTimer = setTimer(() => {
        heartbeat.beat(workerId, activeJobId).catch(() => {});
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    logger.log(`[StreamWorker] started: ${workerId}`);
    while (!stopping) {
      const processed = await runOnce();
      if (!processed && !stopping) await sleep(pollMs);
    }
    if (activeJobPromise) await activeJobPromise;
    logger.log('[StreamWorker] stopped');
  };

  const shutdown = async () => {
    stopping = true;
    if (heartbeatTimer) {
      clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
    await activeProcessor.shutdown?.();
    if (activeJobPromise) await activeJobPromise;
    await heartbeat?.stop(workerId);
  };

  return {
    workerId,
    runOnce,
    start,
    shutdown,
    isStopping: () => stopping,
  };
};

const main = async () => {
  const workerId = createWorkerId();
  const queue = createResolutionQueue(pool, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS });
  const lifecycle = createStreamLifecycle({
    db: pool,
    validator: createHlsValidator({
      timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
      maxBytes: STREAM_MAX_MANIFEST_BYTES,
    }),
    cacheTtlMinutes: STREAM_CACHE_TTL_MINUTES,
    verifyIntervalMinutes: STREAM_VERIFY_INTERVAL_MINUTES,
  });
  const worker = createStreamWorker({
    workerId,
    queue,
    processor: createStreamProcessor({ db: pool, workerId }),
    heartbeat: createWorkerHeartbeatStore(pool),
    prewarm: createStreamPrewarm({
      db: pool,
      queue,
      lifecycle,
      batchSize: STREAM_PREWARM_BATCH_SIZE,
      refreshAheadMinutes: STREAM_REFRESH_AHEAD_MINUTES,
    }),
  });
  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await worker.shutdown();
    await pool.end();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    await worker.start();
  } finally {
    await shutdown();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[StreamWorker] fatal: ${redactSensitive(error.message)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createStreamWorker,
  createWorkerId,
  MIN_LEASE_MARGIN_MS,
};
