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
} = require('../config/env');

const MIN_LEASE_MARGIN_MS = 30_000;

const createWorkerId = () =>
  `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    const error = new Error('Stream resolution timed out');
    error.code = 'RESOLUTION_TIMEOUT';
    reject(error);
  }, timeoutMs);
  Promise.resolve(promise).then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    }
  );
});

const createStreamWorker = ({
  queue = createResolutionQueue(pool, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS }),
  processor = createStreamProcessor({ db: pool }),
  logger = console,
  sleep = delay,
  workerId = createWorkerId(),
  pollMs = STREAM_WORKER_POLL_MS,
  leaseSeconds = STREAM_JOB_LEASE_SECONDS,
  resolutionTimeoutMs = STREAM_RESOLUTION_TIMEOUT_MS,
} = {}) => {
  if (leaseSeconds * 1000 < resolutionTimeoutMs + MIN_LEASE_MARGIN_MS) {
    throw new Error(
      'STREAM_JOB_LEASE_SECONDS must exceed STREAM_RESOLUTION_TIMEOUT_MS by at least 30 seconds'
    );
  }
  let stopping = false;
  let activeJobPromise = null;
  let recycleRequested = false;

  const processClaimedJob = async (job) => {
    try {
      // The default processor applies the configured timeout around the resolver
      // and persists that failure in the stream lifecycle. This outer guard has a
      // small grace period for unexpected hangs elsewhere in the processor.
      await withTimeout(processor(job), resolutionTimeoutMs + 1000);
      await queue.completeJob(job.id, workerId);
      logger.log('[StreamWorker] job completed');
    } catch (error) {
      const code = safeErrorCode(error?.code);
      const terminal = code === 'RESOLUTION_TIMEOUT' || error?.terminal === true;
      await queue.failJob(job.id, workerId, code, { terminal });
      logger.warn(`[StreamWorker] job failed: ${code}`);
      if (terminal) {
        // Promise timeouts cannot cancel the legacy Chromium resolver. Mark the
        // job terminal and recycle this worker instead of allowing a retry to
        // overlap a resolver that may still be unwinding in this process.
        recycleRequested = true;
        stopping = true;
        logger.warn('[StreamWorker] recycle required after terminal timeout');
      }
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
    if (activeJobPromise) await activeJobPromise;
  };

  return {
    workerId,
    runOnce,
    start,
    shutdown,
    isStopping: () => stopping,
    shouldRecycle: () => recycleRequested,
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

  let recycleExit = false;
  try {
    await worker.start();
    recycleExit = worker.shouldRecycle();
  } finally {
    await shutdown();
  }
  // Cleanup has completed. A hard process boundary is the only reliable way
  // this phase can stop the non-AbortSignal-aware legacy browser operation.
  if (recycleExit) process.exit(1);
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
  withTimeout,
  MIN_LEASE_MARGIN_MS,
};
