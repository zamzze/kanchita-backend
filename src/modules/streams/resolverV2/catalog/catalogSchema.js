'use strict';

const { normalizeBaseUrl } = require('../providers/configuredHttpSourceProvider');
const { normalizeMediaMap } = require('../providers/peerTubeSourceProvider');
const { normalizeMediaMap: normalizePlutoMediaMap } =
  require('../providers/plutoSourceProvider');
const { normalizeDomains, normalizePatterns } = require('../resolvers/configuredHttpResolver');
const { normalizeSelectors } = require('../html/staticHtmlExtractor');
const { normalizeMediaPathTemplate } = require('../html/mediaPathTemplate');
const { normalizePublicDomains } = require('../html/htmlConfig');
const {
  HARD_MAX_STEPS,
  normalizeWorkflow,
} = require('../providers/httpWorkflowSourceProvider');
const { HARD_MAX_MAPPING_ATTEMPTS } =
  require('../providers/mappedSourceProviderAdapter');
const { CATALOG_CODES, catalogError } = require('./catalogErrors');

const DEFAULT_LIMITS = Object.freeze({
  sources: 32, resolvers: 64, domains: 16, aliases: 16, pathPrefixes: 16,
});
const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
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
  if (entry.type === 'mapped_http_workflow') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'region', 'baseUrl',
      'timeoutMs', 'maxBytes', 'maxRedirects', 'maxCandidates', 'maxSteps',
      'maxMappingAttempts', 'supportsMovies', 'supportsEpisodes', 'workflow']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const region = typeof entry.region === 'string' ? entry.region.trim().toLowerCase() : '';
    const baseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
      ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
    const maxBytes = integer(entry.maxBytes, 512 * 1024, 1, 2 * 1024 * 1024);
    const maxRedirects = integer(entry.maxRedirects, 3, 0, 10);
    const maxSteps = integer(entry.maxSteps, 5, 1, HARD_MAX_STEPS);
    const maxMappingAttempts = integer(entry.maxMappingAttempts, 3, 1,
      HARD_MAX_MAPPING_ATTEMPTS);
    const workflow = maxSteps === null ? null : normalizeWorkflow(entry.workflow, maxSteps);
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxBytes === null || maxRedirects === null || maxCandidates === null ||
        maxSteps === null || maxMappingAttempts === null || supportsMovies === null ||
        supportsEpisodes === null || !REGION.test(region) || !workflow ||
        (enabled && !baseUrl)) return null;
    return Object.freeze({ id, type: 'mapped_http_workflow', enabled, priority, region,
      baseUrl: baseUrl || '', timeoutMs, maxBytes, maxRedirects, maxCandidates,
      maxSteps, maxMappingAttempts, supportsMovies, supportsEpisodes, workflow });
  }
  if (entry.type === 'internet_archive') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'region', 'baseUrl',
      'timeoutMs', 'maxCandidates', 'maxMappingAttempts', 'supportsMovies',
      'supportsEpisodes']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const region = typeof entry.region === 'string' ? entry.region.trim().toLowerCase() : '';
    const baseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
      ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
    const maxMappingAttempts = integer(entry.maxMappingAttempts, 3, 1,
      HARD_MAX_MAPPING_ATTEMPTS);
    const archiveSupportsEpisodes = boolean(entry.supportsEpisodes, false);
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxCandidates === null || maxCandidates > 8 || maxMappingAttempts === null ||
        supportsMovies === null || archiveSupportsEpisodes === null || !REGION.test(region) ||
        (enabled && !baseUrl)) return null;
    return Object.freeze({ id, type: 'internet_archive', enabled, priority, region,
      baseUrl: baseUrl || '', timeoutMs, maxCandidates, maxMappingAttempts,
      supportsMovies, supportsEpisodes: archiveSupportsEpisodes });
  }
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
  if (entry.type === 'pluto') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'baseUrl', 'bootUrl',
      'timeoutMs', 'maxCandidates', 'mediaMap', 'supportsMovies', 'supportsEpisodes']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const mediaMap = normalizePlutoMediaMap(entry.mediaMap);
    const plutoBaseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
      ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
    const plutoBootUrl = typeof entry.bootUrl === 'string' && normalizeBaseUrl(entry.bootUrl)
      ? normalizeBaseUrl(entry.bootUrl).toString().replace(/\/$/, '') : null;
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxCandidates === null || supportsMovies === null || supportsEpisodes === null ||
        mediaMap === null || (enabled && (!plutoBaseUrl || !plutoBootUrl))) return null;
    return Object.freeze({ id, type: 'pluto', enabled, priority,
      baseUrl: plutoBaseUrl || '', bootUrl: plutoBootUrl || '', timeoutMs,
      maxCandidates, supportsMovies, supportsEpisodes, mediaMap });
  }
  if (entry.type === 'configured_html') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'baseUrl', 'timeoutMs',
      'maxCandidates', 'supportsMovies', 'supportsEpisodes', 'moviePathTemplate',
      'episodePathTemplate', 'selectors', 'allowedCandidateDomains', 'authTokenEnv']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const authTokenEnv = authReference(entry.authTokenEnv);
    const baseUrl = typeof entry.baseUrl === 'string' && normalizeBaseUrl(entry.baseUrl)
      ? normalizeBaseUrl(entry.baseUrl).toString().replace(/\/$/, '') : null;
    const moviePathTemplate = normalizeMediaPathTemplate(
      entry.moviePathTemplate ?? '/movie/{tmdbId}');
    const episodePathTemplate = normalizeMediaPathTemplate(
      entry.episodePathTemplate ?? '/series/{tmdbId}/{season}/{episode}');
    const selectors = normalizeSelectors(entry.selectors,
      ['iframe.src', 'source.src', 'video.src']);
    const allowedCandidateDomains = normalizePublicDomains(entry.allowedCandidateDomains);
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxCandidates === null || supportsMovies === null || supportsEpisodes === null ||
        authTokenEnv === undefined || !selectors || !allowedCandidateDomains ||
        (supportsMovies && !moviePathTemplate) || (supportsEpisodes && !episodePathTemplate) ||
        (enabled && !baseUrl)) return null;
    return Object.freeze({ id, type: 'configured_html', enabled, priority,
      baseUrl: baseUrl || '', timeoutMs, maxCandidates, supportsMovies, supportsEpisodes,
      moviePathTemplate, episodePathTemplate, selectors: Object.freeze(selectors),
      allowedCandidateDomains: Object.freeze(allowedCandidateDomains), authTokenEnv });
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
  if (entry.type === 'configured_html') {
    const allowed = new Set(['id', 'type', 'enabled', 'priority', 'domains', 'aliases',
      'pathPrefixes', 'timeoutMs', 'maxStreams', 'selectors', 'allowedMediaDomains',
      'requestHeaderPolicy', 'playbackHeaderPolicy', 'allowedNestedDomains',
      'maxNextCandidates']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return null;
    const selectors = normalizeSelectors(entry.selectors, ['source.src', 'video.src']);
    const allowedMediaDomains = normalizePublicDomains(entry.allowedMediaDomains);
    const allowedNestedDomains = entry.allowedNestedDomains === undefined ||
      Array.isArray(entry.allowedNestedDomains) && entry.allowedNestedDomains.length === 0
      ? [] : normalizePublicDomains(entry.allowedNestedDomains);
    const maxNextCandidates = integer(entry.maxNextCandidates, 4, 1, 8);
    const htmlDomains = entry.domains === undefined ? [] : normalizePublicDomains(entry.domains);
    const htmlAliases = entry.aliases === undefined ? [] : normalizePublicDomains(entry.aliases);
    const requestHeaderPolicy = entry.requestHeaderPolicy ?? 'referer';
    const playbackHeaderPolicy = entry.playbackHeaderPolicy ?? 'none';
    const policies = ['none', 'referer', 'referer_origin'];
    if (!id || enabled === null || priority === null || timeoutMs === null ||
        maxStreams === null || maxStreams > 8 || htmlDomains === null || htmlAliases === null ||
        pathPrefixes === null || pathPrefixes?.some((prefix) => prefix.includes('*')) ||
        !selectors || !allowedMediaDomains || allowedNestedDomains === null ||
        maxNextCandidates === null || !policies.includes(requestHeaderPolicy) ||
        !policies.includes(playbackHeaderPolicy) || (enabled &&
          htmlDomains.length + htmlAliases.length + pathPrefixes.length === 0)) return null;
    return Object.freeze({ id, type: 'configured_html', enabled, priority,
      domains: Object.freeze(htmlDomains), aliases: Object.freeze(htmlAliases),
      pathPrefixes: Object.freeze(pathPrefixes), timeoutMs, maxStreams,
      selectors: Object.freeze(selectors), allowedMediaDomains: Object.freeze(allowedMediaDomains),
      allowedNestedDomains: Object.freeze(allowedNestedDomains), maxNextCandidates,
      requestHeaderPolicy, playbackHeaderPolicy });
  }
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
