'use strict';

const pool = require('../../config/db');
const { createHlsValidator } = require('./hlsValidator');
const { createResolverExecutor } = require('./resolverExecutor');
const { findStreamContent } = require('./streamContent');
const { createStreamLifecycle, processingError } = require('./streamLifecycle');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
} = require('../../config/env');

const createStreamProcessor = ({
  db = pool,
  resolverExecutor = createResolverExecutor(),
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
  }),
  findContent = (contentType, contentId) => findStreamContent(contentType, contentId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
} = {}) => {
  const lifecycle = createStreamLifecycle({
    db,
    validator,
    logger,
    cacheTtlMinutes,
    verifyIntervalMinutes,
  });

  const processJob = async (job) => {
    const content = await findContent(job.content_type, job.content_id);
    if (!content) throw processingError('INTERNAL_JOB_ERROR');

    // A previous attempt may have persisted the stream and died before completing
    // the job. Rechecking here makes lease recovery idempotent.
    const cached = await lifecycle.readUsableCache(job.content_type, job.content_id);
    if (cached.streams) return cached.streams[0];

    return lifecycle.resolveAndPersist(
      job.content_type,
      job.content_id,
      content,
      (context) => resolverExecutor.resolve(context)
    );
  };

  processJob.shutdown = () => resolverExecutor.shutdown?.();
  return processJob;
};

module.exports = { createStreamProcessor };
