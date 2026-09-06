'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const pool = require('../config/db');
const {
  createResolutionQueue,
  safeErrorCode,
} = require('../modules/streams/resolutionQueue');
const { createStreamProcessor } = require('../modules/streams/streamProcessor');
const { redactSensitive } = require('../utils/redact');
const {
  STREAM_WORKER_POLL_MS,
  STREAM_JOB_LEASE_SECONDS,
  STREAM_JOB_MAX_ATTEMPTS,
  STREAM_RESOLUTION_TIMEOUT_MS,
  STREAM_RESOLVER_KILL_GRACE_MS,
} = require('../config/env');

const MIN_LEASE_MARGIN_MS = 30_000;

const createWorkerId = () =>
  `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const createStreamWorker = ({
  queue = createResolutionQueue(pool, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS }),
  processor = createStreamProcessor({ db: pool }),
  logger = console,
  sleep = delay,
  workerId = createWorkerId(),
  pollMs = STREAM_WORKER_POLL_MS,
  leaseSeconds = STREAM_JOB_LEASE_SECONDS,
  resolutionTimeoutMs = STREAM_RESOLUTION_TIMEOUT_MS,
  resolverKillGraceMs = STREAM_RESOLVER_KILL_GRACE_MS,
} = {}) => {
  if (leaseSeconds * 1000 < resolutionTimeoutMs + resolverKillGraceMs + MIN_LEASE_MARGIN_MS) {
    throw new Error(
      'STREAM_JOB_LEASE_SECONDS must exceed resolver timeout + kill grace by at least 30 seconds'
    );
  }
  let stopping = false;
  let activeJobPromise = null;

  const processClaimedJob = async (job) => {
    try {
      await processor(job);
      await queue.completeJob(job.id, workerId);
      logger.log('[StreamWorker] job completed');
    } catch (error) {
      const code = safeErrorCode(error?.code);
      await queue.failJob(job.id, workerId, code);
      logger.warn(`[StreamWorker] job failed: ${code}`);
    }
  };

  const runOnce = async () => {
    if (stopping || activeJobPromise) return false;
    await queue.recoverStaleJobs(leaseSeconds);
    if (stopping) return false;

    const job = await queue.claimNextJob(workerId);
    if (!job) return false;

    activeJobPromise = processClaimedJob(job);
    try {
      await activeJobPromise;
    } finally {
      activeJobPromise = null;
    }
    return true;
  };

  const start = async () => {
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
    await processor.shutdown?.();
    if (activeJobPromise) await activeJobPromise;
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
  const worker = createStreamWorker();
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
