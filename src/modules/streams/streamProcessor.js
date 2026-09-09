'use strict';

const pool = require('../../config/db');
const { createHlsValidator } = require('./hlsValidator');
const { createResolverExecutor } = require('./resolverExecutor');
const { createProviderManager } = require('./providerManager');
const { createProviderHealthStore } = require('./providerHealth');
const { createBrowserSlotManager } = require('./browserSlots');
const { createMetricsStore } = require('./streamMetrics');
const { createStreamStatsStore } = require('./streamStats');
const { createShadowPipeline } = require('./resolverV2/createShadowPipeline');
const { createShadowLegacyComparator } =
  require('./resolverV2/observability/shadowLegacyComparator');
const { createShadowComparisonStats } =
  require('./resolverV2/observability/shadowComparisonStats');
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
  STREAM_RESOLVER_V2_SHADOW_ENABLED,
  STREAM_RESOLVER_V2_SHADOW_TIMEOUT_MS,
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
  shadowResolver,
  shadowComparator,
  comparisonStats,
  comparisonMetrics,
  lifecycle: injectedLifecycle,
  stats: injectedStats,
} = {}) => {
  const metrics = createMetricsStore(db);
  const shadowComposition = shadowResolver ? null : createShadowPipeline({
    enabled: STREAM_RESOLVER_V2_SHADOW_ENABLED,
    timeoutMs: STREAM_RESOLVER_V2_SHADOW_TIMEOUT_MS,
    metrics,
    logger,
  });
  const shadow = shadowResolver || shadowComposition.shadowResolver;
  const comparator = shadowComparator || shadowComposition?.shadowComparator ||
    createShadowLegacyComparator();
  const comparisons = comparisonStats || shadowComposition?.comparisonStats ||
    createShadowComparisonStats();
  const comparisonMetricStore = comparisonMetrics || null;
  const recordComparisonMetric = (name) => {
    try {
      const pending = comparisonMetricStore?.increment?.(name, 1);
      pending?.catch?.(() => {});
    } catch {
      // Comparison telemetry cannot affect authoritative legacy playback.
    }
  };
  const compareSafely = (shadowResult, legacyResult) => {
    try {
      const summary = comparator.compare({ shadow: shadowResult, legacy: legacyResult });
      try { comparisons.record(summary); } catch { /* best effort */ }
      recordComparisonMetric('resolver_v2_shadow_comparison_total');
      if (summary.shadowReady) recordComparisonMetric('resolver_v2_shadow_ready_comparison_total');
      if (summary.wouldAvoidBrowser === true) {
        recordComparisonMetric('resolver_v2_shadow_would_avoid_browser_total');
      }
      if (summary.legacyBrowserUsed === true) recordComparisonMetric('resolver_v2_legacy_browser_total');
      const qualityMetric = {
        shadow_better: 'resolver_v2_shadow_better_total',
        equivalent: 'resolver_v2_shadow_equivalent_total',
        legacy_better: 'resolver_v2_shadow_legacy_better_total',
      }[summary.qualityComparison];
      if (qualityMetric) recordComparisonMetric(qualityMetric);
      return summary;
    } catch {
      return null;
    }
  };
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
  const stats = injectedStats || createStreamStatsStore(db);
  const lifecycle = injectedLifecycle || createStreamLifecycle({
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
      async (context) => {
        let shadowResult = null;
        if (job.job_type !== 'refresh') {
          try {
            shadowResult = await shadow.run({ ...context });
          } catch {
            shadowResult = { status: 'failed', selected: null };
          }
        }
        const legacyResult = await manager.resolve(context);
        if (job.job_type !== 'refresh') compareSafely(shadowResult, legacyResult);
        return legacyResult;
      },
      { preserveCurrent: job.job_type === 'refresh' }
    );
    await stats.recordReady(job.content_type, job.content_id);
    return result;
  };

  processJob.shutdown = () => resolverExecutor.shutdown?.();
  return processJob;
};

module.exports = { createStreamProcessor };
