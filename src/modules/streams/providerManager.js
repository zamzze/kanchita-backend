'use strict';

const { createProviderRegistry } = require('./providerRegistry');
const { inspectManifestCleanliness } = require('./streamCleanlinessInspector');
const {
  normalizeLanguage,
  normalizeQuality,
  streamScore,
} = require('./streamAttributes');

const createProviderManager = ({
  providers = [],
  registry = createProviderRegistry(providers),
  validator,
  health = {
    isAvailable: async () => true,
    recordSuccess: async () => {},
    recordFailure: async () => {},
  },
  browserSlots = { withSlot: async (owner, operation) => operation() },
  metrics = { increment: async () => {}, observe: async () => {} },
  workerId = 'stream-worker',
  rejectAdMarked = true,
  logger = console,
} = {}) => {
  let lastErrorCode = 'RESOLUTION_FAILED';
  const tryProvider = async (provider, context) => {
    if (!(await health.isAvailable(provider.id))) return null;
    const startedAt = Date.now();
    await metrics.increment('provider_resolution_total');
    if (provider.requiresBrowser) await metrics.increment('browser_resolution_total');
    try {
      const invoke = () => provider.resolve(context);
      const result = provider.requiresBrowser
        ? await browserSlots.withSlot(workerId, invoke)
        : await invoke();
      const results = Array.isArray(result) ? result : [result];
      if (!results.some((item) => item?.url)) throw new Error('empty provider result');
      const candidates = [];
      for (const item of results) {
        if (!item?.url) continue;
        const validationStartedAt = Date.now();
        const validation = await validator(item.url);
        await metrics.observe('hls_validation_ms', Date.now() - validationStartedAt);
        if (!validation.valid) {
          lastErrorCode = validation.code || 'RESOLUTION_FAILED';
          continue;
        }
        const cleanliness = inspectManifestCleanliness(validation.manifest);
        if (cleanliness === 'ad_marked') {
          await metrics.increment('ad_marked_stream_total');
          if (rejectAdMarked) continue;
        }
        candidates.push({
          ...item,
          provider: provider.id,
          strategy: provider.strategy,
          cleanliness,
          quality: normalizeQuality(item.quality || provider.qualityHint),
          audioLanguage: normalizeLanguage(
            item.audioLanguage || item.language || provider.audioLanguages[0]
          ),
          subtitleLanguage: normalizeLanguage(item.subtitleLanguage),
          validated: true,
        });
      }
      if (!candidates.length) {
        const error = new Error('no valid provider candidates');
        error.code = lastErrorCode;
        throw error;
      }
      const duration = Date.now() - startedAt;
      for (const candidate of candidates) {
        candidate.avgResolutionMs = candidate.avgResolutionMs ??
          provider.avgResolutionMs ?? duration;
      }
      await health.recordSuccess(provider.id, duration);
      await metrics.increment('provider_success_total');
      await metrics.observe('resolver_duration_ms', duration);
      return candidates;
    } catch (error) {
      lastErrorCode = typeof error?.code === 'string' ? error.code : 'RESOLUTION_FAILED';
      const duration = Date.now() - startedAt;
      await health.recordFailure(provider.id, duration);
      await metrics.increment('provider_failure_total');
      logger.warn(`[ProviderManager] provider failed: ${provider.id}`);
      return null;
    }
  };

  const resolveCandidates = async (context) => {
    lastErrorCode = 'RESOLUTION_FAILED';
    const candidates = [];
    const compatible = registry.compatible(context.contentType);
    for (const strategy of ['direct', 'browser']) {
      for (const provider of compatible.filter((item) => item.strategy === strategy)) {
        const providerCandidates = await tryProvider(provider, context);
        if (providerCandidates) candidates.push(...providerCandidates);
      }
      if (candidates.length) break;
    }
    const ranked = candidates.sort(
      (left, right) => streamScore(right) - streamScore(left)
    );
    if (ranked.length) return ranked;
    const error = new Error('No stream provider succeeded');
    error.code = lastErrorCode;
    throw error;
  };

  const resolve = async (context) => (await resolveCandidates(context))[0];

  return { resolve, resolveCandidates, registry };
};

module.exports = { createProviderManager };
