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
const { createPrimaryStats } = require('./resolverV2/observability/primaryStats');
const { adaptV2ToLegacyResult } = require('./resolverV2/v2LegacyResultAdapter');
const { selectResolutionMode } = require('./resolverV2/resolutionMode');
const { createPrimaryRolloutGate } = require('./resolverV2/primaryRolloutGate');
const { createPrimaryRuntimeGuard } =
  require('./resolverV2/health/primaryRuntimeGuard');
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
  STREAM_RESOLVER_V2_PRIMARY_ENABLED,
  STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS,
  STREAM_RESOLVER_V2_PRIMARY_ROLLOUT_PERCENT,
  STREAM_RESOLVER_V2_PRIMARY_ROLLOUT_SEED,
  STREAM_RESOLVER_V2_PRIMARY_MOVIES_ENABLED,
  STREAM_RESOLVER_V2_PRIMARY_EPISODES_ENABLED,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_ENABLED,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_MIN_ATTEMPTS,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_WINDOW_SIZE,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_FAILURE_RATE_PERCENT,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_TIMEOUT_RATE_PERCENT,
  STREAM_RESOLVER_V2_PRIMARY_GUARD_COOLDOWN_SECONDS,
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
  primaryResolver,
  primaryEnabled,
  shadowEnabled,
  primaryTimeoutMs = STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS,
  primaryStats,
  primaryMetrics,
  primaryRolloutGate,
  primaryRuntimeGuard,
  primaryRolloutPercent = STREAM_RESOLVER_V2_PRIMARY_ROLLOUT_PERCENT,
  primaryRolloutSeed = STREAM_RESOLVER_V2_PRIMARY_ROLLOUT_SEED,
  primaryMoviesEnabled = STREAM_RESOLVER_V2_PRIMARY_MOVIES_ENABLED,
  primaryEpisodesEnabled = STREAM_RESOLVER_V2_PRIMARY_EPISODES_ENABLED,
  primaryGuardEnabled = STREAM_RESOLVER_V2_PRIMARY_GUARD_ENABLED,
  primaryGuardMinimumAttempts = STREAM_RESOLVER_V2_PRIMARY_GUARD_MIN_ATTEMPTS,
  primaryGuardWindowSize = STREAM_RESOLVER_V2_PRIMARY_GUARD_WINDOW_SIZE,
  primaryGuardFailureRatePercent = STREAM_RESOLVER_V2_PRIMARY_GUARD_FAILURE_RATE_PERCENT,
  primaryGuardTimeoutRatePercent = STREAM_RESOLVER_V2_PRIMARY_GUARD_TIMEOUT_RATE_PERCENT,
  primaryGuardCooldownSeconds = STREAM_RESOLVER_V2_PRIMARY_GUARD_COOLDOWN_SECONDS,
  primaryGuardClock = Date.now,
  primaryAdapter = adaptV2ToLegacyResult,
  lifecycle: injectedLifecycle,
  stats: injectedStats,
} = {}) => {
  const metrics = createMetricsStore(db);
  const effectivePrimaryEnabled = primaryEnabled ?? STREAM_RESOLVER_V2_PRIMARY_ENABLED;
  const effectiveShadowEnabled = shadowEnabled ??
    (shadowResolver ? true : STREAM_RESOLVER_V2_SHADOW_ENABLED);
  const mode = selectResolutionMode({
    primaryEnabled: effectivePrimaryEnabled,
    shadowEnabled: effectiveShadowEnabled,
  });
  const primaryMetricStore = primaryMetrics || (mode === 'primary' ? metrics : null);
  const needsComposition = (mode === 'primary' && !primaryResolver) ||
    (mode === 'shadow' && !shadowResolver);
  const v2Composition = needsComposition ? createShadowPipeline({
    enabled: mode === 'shadow',
    timeoutMs: STREAM_RESOLVER_V2_SHADOW_TIMEOUT_MS,
    metrics,
    logger,
    primaryEnabled: mode === 'primary',
    primaryTimeoutMs,
    primaryMetrics: primaryMetricStore,
  }) : null;
  const shadow = shadowResolver || v2Composition?.shadowResolver || null;
  const primary = primaryResolver || v2Composition?.primaryResolver || null;
  const comparator = shadowComparator || v2Composition?.shadowComparator ||
    createShadowLegacyComparator();
  const comparisons = comparisonStats || v2Composition?.comparisonStats ||
    createShadowComparisonStats();
  const primaryStatistics = primaryStats || v2Composition?.primaryStats || createPrimaryStats();
  const comparisonMetricStore = comparisonMetrics || null;
  const rollout = mode === 'primary' ? (primaryRolloutGate || createPrimaryRolloutGate({
    enabled: effectivePrimaryEnabled, rolloutPercent: primaryRolloutPercent,
    seed: primaryRolloutSeed, moviesEnabled: primaryMoviesEnabled,
    episodesEnabled: primaryEpisodesEnabled,
  })) : null;
  const runtimeGuard = mode === 'primary' ? (primaryRuntimeGuard || createPrimaryRuntimeGuard({
    enabled: primaryGuardEnabled, minimumAttempts: primaryGuardMinimumAttempts,
    windowSize: primaryGuardWindowSize,
    failureRateThreshold: primaryGuardFailureRatePercent,
    timeoutRateThreshold: primaryGuardTimeoutRatePercent,
    cooldownMs: primaryGuardCooldownSeconds * 1000, clock: primaryGuardClock,
  })) : null;

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
  const recordPrimaryMetric = (name) => {
    try {
      const pending = primaryMetricStore?.increment?.(name, 1);
      pending?.catch?.(() => {});
    } catch { /* best effort */ }
  };
  const recordPrimaryDecision = (result, { fallback = false, legacyAvoided = false } = {}) => {
    try {
      primaryStatistics.record({
        status: result?.status || 'failed',
        code: result?.summary?.code,
        fallback,
        legacyAvoided,
      });
    } catch { /* best effort */ }
    if (fallback) recordPrimaryMetric('resolver_v2_primary_fallback_total');
    if (legacyAvoided) recordPrimaryMetric('resolver_v2_primary_legacy_avoided_total');
  };
  const recordRolloutDecision = (reason) => {
    try { primaryStatistics.recordRollout(reason); } catch { /* best effort */ }
    recordPrimaryMetric(reason === 'selected'
      ? 'resolver_v2_primary_rollout_selected_total'
      : 'resolver_v2_primary_rollout_skipped_total');
  };
  const recordGuardEvent = (event) => {
    if (!event) return;
    try { primaryStatistics.recordGuard(event); } catch { /* best effort */ }
    const metric = {
      open: 'resolver_v2_primary_guard_open_total',
      skip: 'resolver_v2_primary_guard_skip_total',
      probe: 'resolver_v2_primary_guard_probe_total',
      recovery: 'resolver_v2_primary_guard_recovery_total',
    }[event];
    if (metric) recordPrimaryMetric(metric);
  };
  const observeGuardOutcome = (status) => {
    const outcome = ['accepted', 'empty', 'rejected', 'timeout', 'failed'].includes(status)
      ? status : 'failed';
    try {
      const observation = runtimeGuard.recordOutcome(outcome);
      recordGuardEvent(observation?.event);
    } catch { /* guard observation cannot alter playback */ }
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
        if (job.job_type === 'refresh') return manager.resolve(context);
        if (mode === 'primary') {
          let rolloutDecision;
          try { rolloutDecision = rollout.evaluate(context); } catch {
            rolloutDecision = { eligible: false, reason: 'invalid_context', bucket: 0 };
          }
          recordRolloutDecision(rolloutDecision.reason);
          if (!rolloutDecision.eligible) return manager.resolve(context);

          let guardDecision;
          try { guardDecision = runtimeGuard.canAttempt(); } catch {
            guardDecision = { allowed: false, state: 'open', probe: false };
          }
          if (!guardDecision.allowed) {
            recordGuardEvent('skip');
            return manager.resolve(context);
          }
          if (guardDecision.probe) recordGuardEvent('probe');

          let primaryResult;
          try {
            primaryResult = await primary.resolve({ ...context }, {
              signal: context.signal,
              deadlineAt: context.deadlineAt,
            });
          } catch {
            primaryResult = { status: 'failed', selected: null,
              summary: { code: 'PRIMARY_UNKNOWN' }, externalAbort: false };
          }
          if (primaryResult?.status === 'aborted' && primaryResult.externalAbort) {
            try { runtimeGuard.cancelAttempt(); } catch { /* best effort */ }
            recordPrimaryDecision(primaryResult);
            throw Object.assign(new Error('Stream processing aborted'), {
              code: 'RESOLUTION_ABORTED',
            });
          }
          if (primaryResult?.status === 'accepted') {
            try {
              const adapted = primaryAdapter(primaryResult.selected);
              observeGuardOutcome('accepted');
              recordPrimaryDecision(primaryResult, { legacyAvoided: true });
              return adapted;
            } catch {
              observeGuardOutcome('failed');
              recordPrimaryDecision({ status: 'rejected',
                summary: { code: 'PRIMARY_INVALID_STREAM' } }, { fallback: true });
              return manager.resolve(context);
            }
          }
          observeGuardOutcome(primaryResult?.status);
          recordPrimaryDecision(primaryResult, { fallback: true });
          return manager.resolve(context);
        }
        if (mode === 'legacy') return manager.resolve(context);
        let shadowResult = null;
        try {
          shadowResult = await shadow.run({ ...context });
        } catch {
          shadowResult = { status: 'failed', selected: null };
        }
        const legacyResult = await manager.resolve(context);
        compareSafely(shadowResult, legacyResult);
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
