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
const { createPlutoSourceProvider } = require('./providers/plutoSourceProvider');
const { createConfiguredHttpResolver } =
  require('./resolvers/configuredHttpResolver');
const { createV2HealthStore } = require('./health/v2HealthStore');
const { createV2Observability } = require('./observability/v2Observability');
const { createStreamRanker } = require('./ranking/streamRanker');
const { createShadowLegacyComparator } =
  require('./observability/shadowLegacyComparator');
const { createShadowComparisonStats } =
  require('./observability/shadowComparisonStats');
const { createPrimaryAcceptanceGate } = require('./primaryAcceptanceGate');
const { createPrimaryResolver } = require('./primaryResolver');
const { createPrimaryStats } = require('./observability/primaryStats');
const { loadResolverV2Catalog } = require('./catalog/catalogLoader');
const { buildResolverV2CatalogRuntime } = require('./catalog/catalogRuntimeBuilder');
const { isPlaybackTransportConfigured } = require('../playbackHeaders');
const PRODUCT_RESOLVER_MAX_DEPTH = 2;
const PRODUCT_RESOLVER_MAX_NODES = 16;
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
  STREAM_RESOLVER_V2_PRIMARY_ENABLED,
  STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS,
  STREAM_TEMPORARY_URL_SAFETY_SECONDS,
  STREAM_RESOLVER_V2_CATALOG_ENABLED,
  STREAM_RESOLVER_V2_CATALOG_PATH,
  STREAM_HLS_PROXY_ENABLED,
  STREAM_HLS_PROXY_SIGNING_SECRET,
  API_BASE_URL,
  PLUTO_ENABLED,
  PLUTO_REGION,
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
  plutoProvider = {},
  providerMappingResolver = null,
  providerMappingStore = null,
  httpResolver = {},
  healthStore = null,
  observability = null,
  healthEnabled = STREAM_RESOLVER_V2_HEALTH_ENABLED,
  ranker = null,
  shadowComparator = null,
  comparisonStats = null,
  primaryEnabled = STREAM_RESOLVER_V2_PRIMARY_ENABLED,
  primaryTimeoutMs = STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS,
  primaryResolver = null,
  primaryAcceptanceGate = null,
  primaryStats = null,
  primaryMetrics = null,
  playbackTransportAvailable = isPlaybackTransportConfigured({
    enabled: STREAM_HLS_PROXY_ENABLED, secret: STREAM_HLS_PROXY_SIGNING_SECRET,
    publicBaseUrl: API_BASE_URL || '',
  }),
  catalogEnabled = STREAM_RESOLVER_V2_CATALOG_ENABLED,
  catalogPath = STREAM_RESOLVER_V2_CATALOG_PATH,
  catalogReadFile,
  catalogEnv = process.env,
  catalogLimits,
  catalogMaxBytes,
  catalogLoader = loadResolverV2Catalog,
  catalogRuntimeBuilder = buildResolverV2CatalogRuntime,
} = {}) => {
  const runtimeTimeoutMs = primaryEnabled ? Math.max(timeoutMs, primaryTimeoutMs) : timeoutMs;
  const activeHttpClient = httpClient || createSafeHttpClient({ timeoutMs: runtimeTimeoutMs });
  const activeObservability = observability || createV2Observability({ maxSamples: 256 });
  const activeRanker = ranker || createStreamRanker({
    temporarySafetyWindowMs: STREAM_TEMPORARY_URL_SAFETY_SECONDS * 1000,
  });
  const activeShadowComparator = shadowComparator || createShadowLegacyComparator();
  const activeComparisonStats = comparisonStats || createShadowComparisonStats();
  const activePrimaryStats = primaryStats || createPrimaryStats();
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
  try {
    const plutoOptions = {
      id: 'pluto', enabled: PLUTO_ENABLED, region: PLUTO_REGION,
      mappingResolver: providerMappingResolver,
      mappingStore: providerMappingStore,
      ...plutoProvider,
      http: activeHttpClient,
    };
    const pluto = createPlutoSourceProvider(plutoOptions);
    if (pluto.descriptor.active && (providerMappingResolver || providerMappingStore) &&
        !configuredProviders.some(({ descriptor }) => descriptor.id === pluto.descriptor.id)) {
      configuredProviders.push(pluto);
    }
  } catch {
    // Invalid optional Pluto configuration fails closed without blocking startup.
  }
  const directHlsResolver = createDirectHlsResolver({
    httpClient: activeHttpClient, timeoutMs: runtimeTimeoutMs,
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

  let catalogSummary = Object.freeze({ loaded: false, version: null,
    sourcesRegistered: 0, resolversRegistered: 0, sourcesSkipped: 0,
    resolversSkipped: 0, errorCodes: Object.freeze([]) });
  if (catalogEnabled === true && !sourceRegistry && !resolverRegistry) {
    try {
      const loadedCatalog = catalogLoader({ enabled: true, filePath: catalogPath,
        readFile: catalogReadFile, env: catalogEnv, limits: catalogLimits,
        maxBytes: catalogMaxBytes });
      if (loadedCatalog?.loaded === true) {
        const built = catalogRuntimeBuilder({ catalog: loadedCatalog, http: activeHttpClient,
          hlsResolver: directHlsResolver, env: catalogEnv,
          mappingResolver: providerMappingResolver,
          existingSourceIds: configuredProviders.map(({ descriptor }) => descriptor.id),
          existingResolverIds: configuredResolvers.map(({ descriptor }) => descriptor.id) });
        configuredProviders.push(...built.sources);
        configuredResolvers.push(...built.resolvers);
        catalogSummary = Object.freeze({ ...built.summary,
          sourcesSkipped: loadedCatalog.summary.skippedSources + built.summary.sourcesSkipped,
          resolversSkipped: loadedCatalog.summary.skippedResolvers + built.summary.resolversSkipped,
          errorCodes: Object.freeze([
            ...loadedCatalog.summary.errorCodes, ...built.summary.errorCodes,
          ]) });
      } else if (loadedCatalog?.summary) {
        catalogSummary = Object.freeze({ ...catalogSummary,
          errorCodes: Object.freeze([...loadedCatalog.summary.errorCodes]) });
      }
    } catch {
      catalogSummary = Object.freeze({ ...catalogSummary,
        errorCodes: Object.freeze(['CATALOG_READ_FAILED']) });
    }
  }

  const activeSourceRegistry = sourceRegistry ||
    createSourceProviderRegistry(configuredProviders);
  const activeSourceManager = sourceProviderManager || createSourceProviderManager({
    registry: activeSourceRegistry,
    http: activeHttpClient,
    providerTimeoutMs: runtimeTimeoutMs,
    globalTimeoutMs: runtimeTimeoutMs,
    healthStore: activeHealthStore,
    observability: activeObservability,
  });
  const activeResolverRegistry = resolverRegistry ||
    createResolverRegistry(configuredResolvers);
  const activeResolverEngine = resolverEngine || createResolverEngine({
    registry: activeResolverRegistry,
    timeoutMs: runtimeTimeoutMs,
    maxDepth: PRODUCT_RESOLVER_MAX_DEPTH,
    maxResolutionNodes: PRODUCT_RESOLVER_MAX_NODES,
    healthStore: activeHealthStore,
    observability: activeObservability,
  });
  const activePipeline = pipeline || createResolutionPipeline({
    sourceProviderManager: activeSourceManager,
    resolverEngine: activeResolverEngine,
    ranker: activeRanker,
  });
  const shadowResolver = createShadowResolver({
    pipeline: activePipeline,
    enabled,
    timeoutMs,
    metrics,
    observability: activeObservability,
    logger,
  });
  const activePrimaryResolver = primaryResolver || createPrimaryResolver({
    pipeline: activePipeline,
    ranker: activeRanker,
    acceptanceGate: primaryAcceptanceGate || createPrimaryAcceptanceGate({
      playbackTransportAvailable,
      minimumExpiryMs: STREAM_TEMPORARY_URL_SAFETY_SECONDS * 1000,
    }),
    enabled: primaryEnabled,
    timeoutMs: primaryTimeoutMs,
    metrics: primaryMetrics,
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
    ranker: activeRanker,
    shadowComparator: activeShadowComparator,
    comparisonStats: activeComparisonStats,
    primaryResolver: activePrimaryResolver,
    primaryStats: activePrimaryStats,
    catalogSummary,
  });
};

module.exports = {
  PRODUCT_RESOLVER_MAX_DEPTH,
  PRODUCT_RESOLVER_MAX_NODES,
  createShadowPipeline,
};
