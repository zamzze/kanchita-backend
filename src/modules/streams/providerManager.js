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
      if (!result?.url) throw new Error('empty provider result');
      const validationStartedAt = Date.now();
      const validation = await validator(result.url);
      await metrics.observe('hls_validation_ms', Date.now() - validationStartedAt);
      if (!validation.valid) {
        const error = new Error('invalid provider stream');
        error.code = validation.code;
        throw error;
      }
      const cleanliness = inspectManifestCleanliness(validation.manifest);
      if (cleanliness === 'ad_marked') {
        await metrics.increment('ad_marked_stream_total');
        if (rejectAdMarked) throw new Error('ad-marked stream rejected');
      }
      const duration = Date.now() - startedAt;
      await health.recordSuccess(provider.id, duration);
      await metrics.increment('provider_success_total');
      await metrics.observe('resolver_duration_ms', duration);
      return {
        ...result,
        provider: provider.id,
        strategy: provider.strategy,
        cleanliness,
        quality: normalizeQuality(result.quality || provider.qualityHint),
        audioLanguage: normalizeLanguage(
          result.audioLanguage || result.language || provider.audioLanguages[0]
        ),
        subtitleLanguage: normalizeLanguage(result.subtitleLanguage),
        validated: true,
      };
    } catch (error) {
      lastErrorCode = typeof error?.code === 'string' ? error.code : 'RESOLUTION_FAILED';
      const duration = Date.now() - startedAt;
      if (lastErrorCode !== 'BROWSER_CAPACITY_UNAVAILABLE') {
        await health.recordFailure(provider.id, duration);
        await metrics.increment('provider_failure_total');
        logger.warn(`[ProviderManager] provider failed: ${provider.id}`);
      } else {
        logger.warn(`[ProviderManager] browser capacity unavailable: ${provider.id}`);
      }
      return null;
    }
  };

  const resolve = async (context) => {
    lastErrorCode = 'RESOLUTION_FAILED';
    const candidates = [];
    const compatible = registry.compatible(context.contentType);
    for (const strategy of ['direct', 'browser']) {
      for (const provider of compatible.filter((item) => item.strategy === strategy)) {
        const candidate = await tryProvider(provider, context);
        if (candidate) candidates.push(candidate);
      }
      if (candidates.length) break;
    }
    const selected = candidates.sort(
      (left, right) => streamScore(right) - streamScore(left)
    )[0];
    if (selected) return selected;
    const error = new Error('No stream provider succeeded');
    error.code = lastErrorCode;
    throw error;
  };

  return { resolve, registry };
};

module.exports = { createProviderManager };
