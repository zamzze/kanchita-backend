'use strict';

const path = require('node:path');
const { loadResolverV2Catalog } = require('../catalog/catalogLoader');
const { normalizeCatalog } = require('../catalog/catalogSchema');
const { buildResolverV2CatalogRuntime } = require('../catalog/catalogRuntimeBuilder');
const { createProviderMediaMappingResolver } = require('../../providerMediaMappingResolver');
const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');

const DEFAULT_CATALOG_PATH = path.resolve(__dirname, '../../../../..',
  'config/resolver-v2/peertube-public-demo.catalog.json');
const DIAGNOSTIC_TMDB_ID = 2_147_000_001;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const parseCatalogProviderSmokeArgs = (argv = []) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json' && !options.json) { options.json = true; continue; }
    if (!['--provider', '--external-id'].includes(item) ||
        options[item.slice(2)] !== undefined || index + 1 >= argv.length) {
      return { ok: false, json: options.json };
    }
    options[item.slice(2)] = argv[++index];
  }
  if (!PROVIDER_ID.test(options.provider || '') || !UUID.test(options['external-id'] || '')) {
    return { ok: false, json: options.json };
  }
  return Object.freeze({ ok: true, json: options.json, providerId: options.provider,
    externalId: options['external-id'] });
};

const safeCode = (error) => SAFE_CODE.test(error?.code || '') ? error.code : 'UNKNOWN_ERROR';

const createTrackedHttpClient = (httpClient, counts) => {
  const call = async (kind, method, url, options) => {
    counts[kind] += 1;
    counts.requestCount += 1;
    const response = await (method === 'request'
      ? httpClient.request(options.method, url, options.requestOptions)
      : httpClient[method](url, options));
    const redirects = Number.isInteger(response?.redirects) && response.redirects > 0
      ? response.redirects : 0;
    counts[kind] += redirects;
    counts.requestCount += redirects;
    return response;
  };
  return Object.freeze({
    request: (method, url, requestOptions) => call('apiRequestCount', 'request', url,
      { method, requestOptions }),
    get: (url, options) => call('hlsRequestCount', 'get', url, options),
    head: (url, options) => call('hlsRequestCount', 'head', url, options),
  });
};

const createCatalogProviderSmoke = ({ httpClient, catalogPath = DEFAULT_CATALOG_PATH,
  readFile, mappingStore, timeoutMs = 12_000, now = Date.now } = {}) => {
  if (!httpClient || typeof httpClient.request !== 'function' ||
      typeof httpClient.get !== 'function' || typeof httpClient.head !== 'function' ||
      typeof catalogPath !== 'string' || !catalogPath ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      typeof now !== 'function' || readFile !== undefined && typeof readFile !== 'function' ||
      mappingStore !== undefined && typeof mappingStore.findActiveMappings !== 'function') {
    throw new Error('CATALOG_PROVIDER_SMOKE_INVALID_CONFIG');
  }

  const run = async ({ providerId, externalId, signal } = {}) => {
    const parsed = parseCatalogProviderSmokeArgs([
      '--provider', providerId, '--external-id', externalId,
    ]);
    if (!parsed.ok) throw new Error('CATALOG_PROVIDER_SMOKE_INVALID_INPUT');
    const startedAt = now();
    const counts = { apiRequestCount: 0, hlsRequestCount: 0, requestCount: 0 };
    const output = (status, extra = {}) => Object.freeze({ status, provider: providerId,
      configLoaded: false, mappingResolved: false, candidateCount: 0, protocol: null,
      validated: false, ...counts, durationMs: Math.max(0, now() - startedAt), ...extra });
    const catalog = loadResolverV2Catalog({ enabled: true, filePath: catalogPath,
      ...(readFile ? { readFile } : {}), env: {} });
    const selected = catalog.sources.find((entry) => entry.id === providerId);
    if (!catalog.loaded || !selected || selected.type !== 'mapped_http_workflow') {
      return output('CATALOG_UNAVAILABLE');
    }
    const diagnostic = normalizeCatalog({ version: 1,
      sources: [{ ...selected, enabled: true }], resolvers: [] });
    if (diagnostic.sources.length !== 1) return output('CATALOG_UNAVAILABLE');

    const mediaContext = Object.freeze({ contentType: 'movie',
      contentId: 'public-catalog-diagnostic', tmdbId: DIAGNOSTIC_TMDB_ID,
      title: 'Public catalog diagnostic' });
    let mappingResolved = false;
    const store = mappingStore || Object.freeze({ findActiveMappings: async (identity) => [{
      id: 1, provider_id: identity.providerId, region: identity.region,
      content_type: identity.contentType, tmdb_id: identity.tmdbId,
      season_number: null, episode_number: null, external_id: externalId,
      match_method: 'diagnostic_explicit', match_confidence: 100, metadata: {},
    }] });
    const mapping = createProviderMediaMappingResolver({ store: {
      findActiveMappings: async (identity) => {
        const rows = await store.findActiveMappings(identity);
        mappingResolved = Array.isArray(rows) && rows.length > 0;
        return rows;
      },
    }, maxMappings: 1 });
    const tracked = createTrackedHttpClient(httpClient, counts);
    const directHls = createDirectHlsResolver({ httpClient: tracked, timeoutMs: 5_000 });
    const runtime = buildResolverV2CatalogRuntime({
      catalog: { ...diagnostic, loaded: true }, http: tracked,
      hlsResolver: directHls, mappingResolver: mapping, env: {},
    });
    if (runtime.sources.length !== 1 || runtime.sources[0].descriptor.id !== providerId) {
      return output('CATALOG_UNAVAILABLE', { configLoaded: true });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const candidates = await runtime.sources[0].getSources(mediaContext, {
        signal: controller.signal, deadlineAt: startedAt + timeoutMs,
      });
      if (!candidates.length) return output('RESOLUTION_EMPTY', {
        configLoaded: true, mappingResolved });
      const engine = createResolverEngine({
        registry: createResolverRegistry([directHls]), timeoutMs, maxStreams: 1,
      });
      const result = await engine.resolve({ mediaContext, candidates,
        signal: controller.signal });
      const stream = result.streams[0];
      const failed = result.attempts.find((attempt) => attempt.outcome === 'failed');
      return output(stream ? 'RESOLUTION_READY' : failed ? 'RESOLUTION_FAILED'
        : 'RESOLUTION_EMPTY', { configLoaded: true, mappingResolved,
        candidateCount: candidates.length, protocol: stream?.protocol || null,
        validated: stream?.validated === true,
        ...(failed?.errorCode ? { errorCode: failed.errorCode } : {}) });
    } catch (error) {
      return output('RESOLUTION_FAILED', { configLoaded: true, mappingResolved,
        errorCode: safeCode(error) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  };
  return Object.freeze({ run });
};

const formatCatalogProviderSmoke = (result, json = false) => json
  ? JSON.stringify(result)
  : Object.entries(result).map(([key, value]) => `${key}=${value ?? 'null'}`).join('\n');

module.exports = { DEFAULT_CATALOG_PATH, DIAGNOSTIC_TMDB_ID,
  createCatalogProviderSmoke, formatCatalogProviderSmoke, parseCatalogProviderSmokeArgs };
