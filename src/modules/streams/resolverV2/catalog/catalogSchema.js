'use strict';

const { normalizeBaseUrl } = require('../providers/configuredHttpSourceProvider');
const { normalizeMediaMap } = require('../providers/peerTubeSourceProvider');
const { normalizeDomains, normalizePatterns } = require('../resolvers/configuredHttpResolver');
const { CATALOG_CODES, catalogError } = require('./catalogErrors');

const DEFAULT_LIMITS = Object.freeze({
  sources: 32, resolvers: 64, domains: 16, aliases: 16, pathPrefixes: 16,
});
const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SECRET_ENV = /^STREAM_RESOLVER_V2_SECRET_[A-Z0-9_]{1,96}$/;
const DANGEROUS_FIELDS = Object.freeze([
  'headers', 'modulePath', 'script', 'code', 'browser', 'requiresBrowser',
  'urlPatterns', 'regex', '__proto__', 'prototype', 'constructor',
]);

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const integer = (value, fallback, minimum, maximum) => {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
};
const boolean = (value, fallback) => value === undefined
  ? fallback : typeof value === 'boolean' ? value : null;
const safeId = (value) => typeof value === 'string' && ID.test(value.trim().toLowerCase())
  ? value.trim().toLowerCase() : null;
const authReference = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && SECRET_ENV.test(value.trim()) ? value.trim() : undefined;
};
const hasDangerousFields = (entry) => DANGEROUS_FIELDS.some((key) =>
  Object.prototype.hasOwnProperty.call(entry, key));
const normalizeStringList = (value, maximum, normalizer) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) return null;
  return normalizer(value);
};

const normalizeSource = (entry) => {
  if (!isPlainObject(entry) || hasDangerousFields(entry)) return null;
  const id = safeId(entry.id);
  const enabled = boolean(entry.enabled, false);
  const priority = integer(entry.priority, 100, -1_000_000, 1_000_000);
  const timeoutMs = integer(entry.timeoutMs, 2_000, 100, 10_000);
  const maxCandidates = integer(entry.maxCandidates, 8, 1, 32);
  const supportsMovies = boolean(entry.supportsMovies, true);
  const supportsEpisodes = boolean(entry.supportsEpisodes, true);
  if (entry.type === 'peertube') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'baseUrl', 'timeoutMs',
      'maxCandidates', 'mediaMap', 'supportsMovies', 'supportsEpisodes']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const mediaMap = normalizeMediaMap(entry.mediaMap);
    const peerBaseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
      ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxCandidates === null || supportsMovies === null || supportsEpisodes === null ||
        mediaMap === null || (enabled && !peerBaseUrl)) return null;
    return Object.freeze({ id, type: 'peertube', enabled, priority,
      baseUrl: peerBaseUrl || '', timeoutMs, maxCandidates, supportsMovies,
      supportsEpisodes, mediaMap });
  }
  const authTokenEnv = authReference(entry.authTokenEnv);
  const baseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
    ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
  if (!id || entry.type !== 'configured_http' || enabled === null || priority === null ||
      timeoutMs === null || maxCandidates === null || supportsMovies === null ||
      supportsEpisodes === null || authTokenEnv === undefined || (enabled && !baseUrl)) return null;
  return Object.freeze({ id, type: 'configured_http', enabled, priority,
    baseUrl: baseUrl || '', timeoutMs, maxCandidates, supportsMovies, supportsEpisodes,
    authTokenEnv });
};

const normalizeResolver = (entry, limits) => {
  if (!isPlainObject(entry) || hasDangerousFields(entry)) return null;
  const id = safeId(entry.id);
  const enabled = boolean(entry.enabled, false);
  const priority = integer(entry.priority, 2_000, -1_000_000, 1_000_000);
  const timeoutMs = integer(entry.timeoutMs, 2_000, 100, 10_000);
  const maxStreams = integer(entry.maxStreams, 4, 1, 16);
  const authTokenEnv = authReference(entry.authTokenEnv);
  const domains = normalizeStringList(entry.domains, limits.domains, normalizeDomains);
  const aliases = normalizeStringList(entry.aliases, limits.aliases, normalizeDomains);
  const pathPrefixes = normalizeStringList(
    entry.pathPrefixes, limits.pathPrefixes, normalizePatterns
  );
  const hasRoute = (domains?.length || 0) + (aliases?.length || 0) +
    (pathPrefixes?.length || 0) > 0;
  if (!id || entry.type !== 'configured_http' || enabled === null || priority === null ||
      timeoutMs === null || maxStreams === null || authTokenEnv === undefined ||
      domains === null || aliases === null || pathPrefixes === null ||
      pathPrefixes?.some((prefix) => prefix.includes('*')) || (enabled && !hasRoute)) {
    return null;
  }
  return Object.freeze({ id, type: 'configured_http', enabled, priority,
    domains: Object.freeze(domains), aliases: Object.freeze(aliases),
    pathPrefixes: Object.freeze(pathPrefixes), timeoutMs, maxStreams, authTokenEnv });
};

const normalizeLimits = (limits = {}) => {
  if (!isPlainObject(limits)) throw catalogError(CATALOG_CODES.LIMIT_EXCEEDED);
  const output = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    output[key] = integer(limits[key], fallback, 1, fallback);
    if (output[key] === null) throw catalogError(CATALOG_CODES.LIMIT_EXCEEDED);
  }
  return output;
};

const normalizeCatalog = (input, { limits } = {}) => {
  if (!isPlainObject(input)) throw catalogError(CATALOG_CODES.INVALID_ROOT);
  if (input.version !== 1) {
    throw catalogError(input.version === undefined
      ? CATALOG_CODES.INVALID_ROOT : CATALOG_CODES.UNSUPPORTED_VERSION);
  }
  const sourceEntries = input.sources === undefined ? [] : input.sources;
  const resolverEntries = input.resolvers === undefined ? [] : input.resolvers;
  if (!Array.isArray(sourceEntries) || !Array.isArray(resolverEntries)) {
    throw catalogError(CATALOG_CODES.INVALID_ROOT);
  }
  const activeLimits = normalizeLimits(limits);
  if (sourceEntries.length > activeLimits.sources ||
      resolverEntries.length > activeLimits.resolvers) {
    throw catalogError(CATALOG_CODES.LIMIT_EXCEEDED);
  }
  const errors = [];
  const sources = [];
  const resolvers = [];
  const sourceIds = new Set();
  const resolverIds = new Set();
  for (const entry of sourceEntries) {
    const normalized = normalizeSource(entry);
    if (!normalized) { errors.push(CATALOG_CODES.INVALID_SOURCE); continue; }
    if (sourceIds.has(normalized.id)) { errors.push(CATALOG_CODES.DUPLICATE_SOURCE); continue; }
    sourceIds.add(normalized.id);
    sources.push(normalized);
  }
  for (const entry of resolverEntries) {
    const normalized = normalizeResolver(entry, activeLimits);
    if (!normalized) { errors.push(CATALOG_CODES.INVALID_RESOLVER); continue; }
    if (resolverIds.has(normalized.id)) {
      errors.push(CATALOG_CODES.DUPLICATE_RESOLVER);
      continue;
    }
    resolverIds.add(normalized.id);
    resolvers.push(normalized);
  }
  return Object.freeze({
    version: 1,
    sources: Object.freeze(sources),
    resolvers: Object.freeze(resolvers),
    summary: Object.freeze({
      sourceEntries: sourceEntries.length,
      resolverEntries: resolverEntries.length,
      validSources: sources.length,
      validResolvers: resolvers.length,
      skippedSources: sourceEntries.length - sources.length,
      skippedResolvers: resolverEntries.length - resolvers.length,
      errorCodes: Object.freeze([...errors]),
    }),
  });
};

module.exports = { DEFAULT_LIMITS, normalizeCatalog };
