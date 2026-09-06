'use strict';

const pool = require('../../config/db');
const { createHlsValidator } = require('./hlsValidator');
const { createResolverExecutor } = require('./resolverExecutor');
const { createProviderManager } = require('./providerManager');
const { createProviderHealthStore } = require('./providerHealth');
const { createBrowserSlotManager } = require('./browserSlots');
const { createMetricsStore } = require('./streamMetrics');
const { createStreamStatsStore } = require('./streamStats');
const { findStreamContent } = require('./streamContent');
const { createStreamLifecycle, processingError } = require('./streamLifecycle');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
  STREAM_BROWSER_MAX_CONCURRENT,
  STREAM_BROWSER_SLOT_LEASE_SECONDS,
  STREAM_RESOLUTION_TIMEOUT_MS,
  STREAM_PROVIDER_FAILURE_THRESHOLD,
  STREAM_PROVIDER_COOLDOWN_SECONDS,
  STREAM_REJECT_AD_MARKED,
} = require('../../config/env');

const createStreamProcessor = ({
  db = pool,
  resolverExecutor = createResolverExecutor(),
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
    includeManifest: true,
  }),
  findContent = (contentType, contentId) => findStreamContent(contentType, contentId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
  workerId = 'stream-worker',
  providerManager,
} = {}) => {
  const metrics = createMetricsStore(db);
  const health = createProviderHealthStore(db, {
    failureThreshold: STREAM_PROVIDER_FAILURE_THRESHOLD,
    cooldownSeconds: STREAM_PROVIDER_COOLDOWN_SECONDS,
  });
  const browserSlots = createBrowserSlotManager(db, {
    maxConcurrent: STREAM_BROWSER_MAX_CONCURRENT,
    leaseSeconds: STREAM_BROWSER_SLOT_LEASE_SECONDS,
    waitTimeoutMs: STREAM_RESOLUTION_TIMEOUT_MS,
    metrics,
  });
  const manager = providerManager || createProviderManager({
    providers: [{
      id: 'provider_c',
      strategy: 'browser',
      supportsMovies: true,
      supportsEpisodes: true,
      audioLanguages: ['en'],
      qualityHint: '1080p',
      expensive: true,
      fallback: true,
      resolve: (context) => resolverExecutor.resolve(context),
    }],
    validator,
    health,
    browserSlots,
    metrics,
    workerId,
    rejectAdMarked: STREAM_REJECT_AD_MARKED,
    logger,
  });
  const stats = createStreamStatsStore(db);
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
    if (cached.streams && job.job_type !== 'refresh') return cached.streams[0];

    const result = await lifecycle.resolveAndPersist(
      job.content_type,
      job.content_id,
      content,
      (context) => manager.resolve(context),
      { preserveCurrent: job.job_type === 'refresh' }
    );
    await stats.recordReady(job.content_type, job.content_id);
    return result;
  };

  processJob.shutdown = () => resolverExecutor.shutdown?.();
  return processJob;
};

module.exports = { createStreamProcessor };
