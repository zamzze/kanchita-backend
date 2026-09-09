'use strict';

const { createSafeHttpClient } = require('../http/safeHttpClient');
const { createSourceProviderRegistry } = require('./sourceProviderRegistry');
const { createSourceProviderManager } = require('./sourceProviderManager');
const { createResolverRegistry } = require('./resolverRegistry');
const { createDirectHlsResolver } = require('./resolvers/directHlsResolver');
const { createResolverEngine } = require('./resolverEngine');
const { createResolutionPipeline } = require('./resolutionPipeline');
const { createShadowResolver } = require('./shadowResolver');

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
} = {}) => {
  const activeHttpClient = httpClient || createSafeHttpClient({ timeoutMs });
  const activeSourceRegistry = sourceRegistry || createSourceProviderRegistry(sourceProviders);
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
