'use strict';

const { createConfiguredHttpSourceProvider } =
  require('../providers/configuredHttpSourceProvider');
const { createConfiguredHttpResolver } = require('../resolvers/configuredHttpResolver');
const { CATALOG_CODES } = require('./catalogErrors');

const buildResolverV2CatalogRuntime = ({
  catalog,
  http,
  hlsResolver,
  env = process.env,
  existingSourceIds = [],
  existingResolverIds = [],
} = {}) => {
  const sources = [];
  const resolvers = [];
  const errors = [];
  const sourceIds = new Set(existingSourceIds);
  const resolverIds = new Set(existingResolverIds);
  const entries = catalog?.loaded === true ? catalog : { sources: [], resolvers: [] };
  for (const entry of entries.sources || []) {
    if (!entry.enabled) continue;
    if (entry.type !== 'configured_http') { errors.push(CATALOG_CODES.INVALID_SOURCE); continue; }
    if (sourceIds.has(entry.id)) { errors.push(CATALOG_CODES.DUPLICATE_SOURCE); continue; }
    const token = entry.authTokenEnv ? env[entry.authTokenEnv] : null;
    if (entry.authTokenEnv && (typeof token !== 'string' || !token.trim())) {
      errors.push(CATALOG_CODES.MISSING_SECRET);
      continue;
    }
    try {
      const source = createConfiguredHttpSourceProvider({
        id: entry.id, enabled: true, priority: entry.priority, baseUrl: entry.baseUrl,
        timeoutMs: entry.timeoutMs, maxCandidates: entry.maxCandidates,
        supportsMovies: entry.supportsMovies, supportsEpisodes: entry.supportsEpisodes,
        headers: token ? { authorization: `Bearer ${token}` } : {}, http,
      });
      if (!source.descriptor.active) throw new Error('inactive');
      sourceIds.add(entry.id);
      sources.push(source);
    } catch {
      errors.push(CATALOG_CODES.INVALID_SOURCE);
    }
  }
  for (const entry of entries.resolvers || []) {
    if (!entry.enabled) continue;
    if (entry.type !== 'configured_http') { errors.push(CATALOG_CODES.INVALID_RESOLVER); continue; }
    if (resolverIds.has(entry.id)) { errors.push(CATALOG_CODES.DUPLICATE_RESOLVER); continue; }
    const token = entry.authTokenEnv ? env[entry.authTokenEnv] : null;
    if (entry.authTokenEnv && (typeof token !== 'string' || !token.trim())) {
      errors.push(CATALOG_CODES.MISSING_SECRET);
      continue;
    }
    try {
      const resolver = createConfiguredHttpResolver({
        id: entry.id, enabled: true, priority: entry.priority, domains: entry.domains,
        aliases: entry.aliases, urlPatterns: entry.pathPrefixes,
        timeoutMs: entry.timeoutMs, maxStreams: entry.maxStreams,
        headers: token ? { authorization: `Bearer ${token}` } : {}, http, hlsResolver,
      });
      if (!resolver.descriptor.active) throw new Error('inactive');
      resolverIds.add(entry.id);
      resolvers.push(resolver);
    } catch {
      errors.push(CATALOG_CODES.INVALID_RESOLVER);
    }
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    resolvers: Object.freeze(resolvers),
    summary: Object.freeze({
      loaded: entries.loaded === true,
      version: entries.version === 1 ? 1 : null,
      sourcesRegistered: sources.length,
      resolversRegistered: resolvers.length,
      sourcesSkipped: (entries.sources?.filter((entry) => entry.enabled).length || 0) - sources.length,
      resolversSkipped: (entries.resolvers?.filter((entry) => entry.enabled).length || 0) - resolvers.length,
      errorCodes: Object.freeze(errors),
    }),
  });
};

module.exports = { buildResolverV2CatalogRuntime };
