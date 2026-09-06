'use strict';

const pool = require('../../config/db');
const { createHlsValidator } = require('./hlsValidator');
const { resolveStream } = require('./streamResolver');
const { findStreamContent } = require('./streamContent');
const { createStreamLifecycle, processingError } = require('./streamLifecycle');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
  STREAM_RESOLUTION_TIMEOUT_MS,
} = require('../../config/env');

const withResolverTimeout = (resolver, timeoutMs) => (context) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Stream resolution timed out');
      error.code = 'RESOLUTION_TIMEOUT';
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(() => resolver(context)).then(
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

const createStreamProcessor = ({
  db = pool,
  resolver = resolveStream,
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
  }),
  findContent = (contentType, contentId) => findStreamContent(contentType, contentId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
  resolutionTimeoutMs = STREAM_RESOLUTION_TIMEOUT_MS,
} = {}) => {
  const lifecycle = createStreamLifecycle({
    db,
    validator,
    logger,
    cacheTtlMinutes,
    verifyIntervalMinutes,
  });

  return async (job) => {
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
      withResolverTimeout(resolver, resolutionTimeoutMs)
    );
  };
};

module.exports = { createStreamProcessor, withResolverTimeout };
