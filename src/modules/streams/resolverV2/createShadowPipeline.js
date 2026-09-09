'use strict';

const { createSafeHttpClient } = require('../http/safeHttpClient');
const { createSourceProviderRegistry } = require('./sourceProviderRegistry');
const { createSourceProviderManager } = require('./sourceProviderManager');
const { createResolverRegistry } = require('./resolverRegistry');
const { createDirectHlsResolver } = require('./resolvers/directHlsResolver');
const { createResolverEngine } = require('./resolverEngine');
const { createResolutionPipeline } = require('./resolutionPipeline');
const { createShadowResolver } = require('./shadowResolver');
const { createConfiguredHttpSourceProvider } =
  require('./providers/configuredHttpSourceProvider');
const { createConfiguredHttpResolver } =
  require('./resolvers/configuredHttpResolver');
const { createV2HealthStore } = require('./health/v2HealthStore');
const { createV2Observability } = require('./observability/v2Observability');
const {
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ID,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_BASE_URL,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_TIMEOUT_MS,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_MAX_CANDIDATES,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_AUTH_TOKEN,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_ENABLED,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_ID,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_DOMAINS,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_TIMEOUT_MS,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_MAX_STREAMS,
  STREAM_RESOLVER_V2_HTTP_RESOLVER_AUTH_TOKEN,
  STREAM_RESOLVER_V2_HEALTH_ENABLED,
  STREAM_RESOLVER_V2_FAILURE_THRESHOLD,
  STREAM_RESOLVER_V2_COOLDOWN_SECONDS,
  STREAM_RESOLVER_V2_HALF_OPEN_SUCCESS_THRESHOLD,
} = require('../../../config/env');

const createShadowPipeline = ({
  enabled = false,
  timeoutMs = 1_500,
  metrics,
  logger,
  sourceProviders = [],
  httpClient,
  sourceRegistry,
  sourceProviderManager,
  resolverRegistry,
  resolverEngine,
  pipeline,
  httpProvider = {},
  httpResolver = {},
  healthStore = null,
  observability = null,
  healthEnabled = STREAM_RESOLVER_V2_HEALTH_ENABLED,
} = {}) => {
  const activeHttpClient = httpClient || createSafeHttpClient({ timeoutMs });
  const activeObservability = observability || createV2Observability({ maxSamples: 256 });
  const healthEvent = (type, kind) => {
    const suffix = type === 'open' ? 'circuit_open'
      : type === 'skip' ? 'circuit_skip'
        : type === 'half_open_probe' ? 'half_open_probe' : 'circuit_recovery';
    try { activeObservability.increment(`${kind}_${suffix}`); } catch { /* best effort */ }
    try {
      const pending = metrics?.increment?.(`resolver_v2_${kind}_${suffix}_total`, 1);
      pending?.catch?.(() => {});
    } catch { /* best effort */ }
  };
  const activeHealthStore = healthStore || (healthEnabled ? createV2HealthStore({
    failureThreshold: STREAM_RESOLVER_V2_FAILURE_THRESHOLD,
    cooldownMs: STREAM_RESOLVER_V2_COOLDOWN_SECONDS * 1000,
    successThreshold: STREAM_RESOLVER_V2_HALF_OPEN_SUCCESS_THRESHOLD,
    onEvent: healthEvent,
  }) : null);
  const providerOptions = {
    enabled: STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED,
    id: STREAM_RESOLVER_V2_HTTP_PROVIDER_ID,
    baseUrl: STREAM_RESOLVER_V2_HTTP_PROVIDER_BASE_URL,
    timeoutMs: STREAM_RESOLVER_V2_HTTP_PROVIDER_TIMEOUT_MS,
    maxCandidates: STREAM_RESOLVER_V2_HTTP_PROVIDER_MAX_CANDIDATES,
    headers: STREAM_RESOLVER_V2_HTTP_PROVIDER_AUTH_TOKEN
      ? { authorization: `Bearer ${STREAM_RESOLVER_V2_HTTP_PROVIDER_AUTH_TOKEN}` } : {},
    ...httpProvider,
    http: activeHttpClient,
  };
  const configuredProviders = [...sourceProviders];
  try {
    const configuredProvider = createConfiguredHttpSourceProvider(providerOptions);
    if (configuredProvider.descriptor.active) configuredProviders.push(configuredProvider);
  } catch {
    // Invalid optional provider configuration fails closed without blocking startup.
  }
  const activeSourceRegistry = sourceRegistry ||
    createSourceProviderRegistry(configuredProviders);
  const activeSourceManager = sourceProviderManager || createSourceProviderManager({
    registry: activeSourceRegistry,
    http: activeHttpClient,
    providerTimeoutMs: timeoutMs,
    globalTimeoutMs: timeoutMs,
    healthStore: activeHealthStore,
    observability: activeObservability,
  });
  const directHlsResolver = createDirectHlsResolver({
    httpClient: activeHttpClient, timeoutMs,
  });
  const configuredResolvers = [directHlsResolver];
  try {
    const configuredResolver = createConfiguredHttpResolver({
      enabled: STREAM_RESOLVER_V2_HTTP_RESOLVER_ENABLED,
      id: STREAM_RESOLVER_V2_HTTP_RESOLVER_ID,
      domains: STREAM_RESOLVER_V2_HTTP_RESOLVER_DOMAINS,
      timeoutMs: STREAM_RESOLVER_V2_HTTP_RESOLVER_TIMEOUT_MS,
      maxStreams: STREAM_RESOLVER_V2_HTTP_RESOLVER_MAX_STREAMS,
      headers: STREAM_RESOLVER_V2_HTTP_RESOLVER_AUTH_TOKEN
        ? { authorization: `Bearer ${STREAM_RESOLVER_V2_HTTP_RESOLVER_AUTH_TOKEN}` } : {},
      ...httpResolver,
      http: activeHttpClient,
      hlsResolver: directHlsResolver,
    });
    if (configuredResolver.descriptor.active) configuredResolvers.push(configuredResolver);
  } catch {
    // Invalid optional resolver configuration fails closed.
  }
  const activeResolverRegistry = resolverRegistry ||
    createResolverRegistry(configuredResolvers);
  const activeResolverEngine = resolverEngine || createResolverEngine({
    registry: activeResolverRegistry,
    timeoutMs,
    healthStore: activeHealthStore,
    observability: activeObservability,
  });
  const activePipeline = pipeline || createResolutionPipeline({
    sourceProviderManager: activeSourceManager,
    resolverEngine: activeResolverEngine,
  });
  const shadowResolver = createShadowResolver({
    pipeline: activePipeline,
    enabled,
    timeoutMs,
    metrics,
    observability: activeObservability,
    logger,
  });

  return Object.freeze({
    shadowResolver,
    pipeline: activePipeline,
    sourceProviderManager: activeSourceManager,
    sourceRegistry: activeSourceRegistry,
    resolverEngine: activeResolverEngine,
    resolverRegistry: activeResolverRegistry,
    healthStore: activeHealthStore,
    observability: activeObservability,
  });
};

module.exports = { createShadowPipeline };
