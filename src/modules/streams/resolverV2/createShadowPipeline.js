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
const {
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ID,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_BASE_URL,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_TIMEOUT_MS,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_MAX_CANDIDATES,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_AUTH_TOKEN,
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
} = {}) => {
  const activeHttpClient = httpClient || createSafeHttpClient({ timeoutMs });
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
  });
  const activeResolverRegistry = resolverRegistry || createResolverRegistry([
    createDirectHlsResolver({ httpClient: activeHttpClient, timeoutMs }),
  ]);
  const activeResolverEngine = resolverEngine || createResolverEngine({
    registry: activeResolverRegistry,
    timeoutMs,
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
    logger,
  });

  return Object.freeze({
    shadowResolver,
    pipeline: activePipeline,
    sourceProviderManager: activeSourceManager,
    sourceRegistry: activeSourceRegistry,
    resolverEngine: activeResolverEngine,
    resolverRegistry: activeResolverRegistry,
  });
};

module.exports = { createShadowPipeline };
