'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://catalog:catalog@127.0.0.1:5432/catalog';
process.env.JWT_SECRET ||= 'catalog-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'catalog-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'catalog-test-tmdb';

const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');

const loaded = (payload, env = {}) => loadResolverV2Catalog({ enabled: true,
  filePath: 'catalog.json', readFile: () => JSON.stringify(payload), env });
const source = (id, overrides = {}) => ({ id, type: 'configured_http', enabled: true,
  baseUrl: `https://${id.replaceAll('_', '-')}.example.test`, ...overrides });
const resolver = (id, overrides = {}) => ({ id, type: 'configured_http', enabled: true,
  domains: [`${id.replaceAll('_', '-')}.example.test`], ...overrides });
const hlsResolver = { resolve: async () => [] };
const fakeHttp = { get: async () => {}, head: async () => {} };
const mappedSource = (id, baseUrl, overrides = {}) => ({
  id, type: 'mapped_http_workflow', enabled: true, region: 'global', baseUrl,
  workflow: [
    { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json', path: 'data.url', saveAs: 'url' },
    { type: 'emit', url: '{url}', languageHint: 'es-419' },
  ],
  ...overrides,
});
const mappingRef = (externalId) => Object.freeze({ mappingId: 1,
  providerId: 'workflow_a', region: 'global', contentType: 'movie', tmdbId: 1,
  externalId, seasonNumber: null, episodeNumber: null, providerTitle: null,
  providerSlug: null, matchMethod: 'manual', matchConfidence: 100,
  metadata: Object.freeze({}), lastVerifiedAt: null });

test('builder maps zero, one and N entries through approved factories', () => {
  for (const count of [0, 1, 3]) {
    const catalog = loaded({ version: 1,
      sources: Array.from({ length: count }, (_, index) => source(`source_${index}`)),
      resolvers: Array.from({ length: count }, (_, index) => resolver(`resolver_${index}`)),
    });
    const runtime = buildResolverV2CatalogRuntime({ catalog,
      http: fakeHttp, hlsResolver, env: {} });
    assert.equal(runtime.sources.length, count);
    assert.equal(runtime.resolvers.length, count);
  }
});

test('builder preserves priority, media support and deterministic registry order', () => {
  const entries = [source('source_c', { priority: 5 }), source('source_a', { priority: 10,
    supportsMovies: false }), source('source_b', { priority: 10 })];
  const resolverEntries = [resolver('resolver_c'), resolver('resolver_a'), resolver('resolver_b')];
  const make = (sources, resolvers) => createShadowPipeline({ catalogEnabled: true,
    catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1, sources, resolvers }),
    httpClient: { get: async () => { throw new Error('no request'); },
      head: async () => { throw new Error('no request'); } },
    healthEnabled: false });
  const first = make(entries, resolverEntries);
  const second = make([...entries].reverse(), [...resolverEntries].reverse());
  assert.deepEqual(first.sourceRegistry.list().map((item) => item.descriptor.id),
    ['source_a', 'source_b', 'source_c']);
  assert.deepEqual(second.sourceRegistry.list().map((item) => item.descriptor.id),
    ['source_a', 'source_b', 'source_c']);
  assert.deepEqual(first.resolverRegistry.list().map((item) => item.descriptor.id),
    ['resolver_a', 'resolver_b', 'resolver_c', 'direct_hls']);
  assert.deepEqual(second.resolverRegistry.list().map((item) => item.descriptor.id),
    ['resolver_a', 'resolver_b', 'resolver_c', 'direct_hls']);
  assert.deepEqual(first.sourceRegistry.listForMedia({ contentType: 'movie', contentId: 'x',
    tmdbId: 1, title: 'X' }).map((item) => item.descriptor.id), ['source_b', 'source_c']);
});

test('builder creates one mapped source and preserves its public descriptor', () => {
  const catalog = loaded({ version: 1, sources: [mappedSource('workflow_a',
    'https://workflow.example.test', { priority: 77, supportsMovies: true,
      supportsEpisodes: false, timeoutMs: 2500, maxCandidates: 4 })] });
  const runtime = buildResolverV2CatalogRuntime({ catalog, http: fakeHttp, hlsResolver,
    mappingResolver: { resolve: async () => [] } });
  assert.equal(runtime.sources.length, 1);
  assert.deepEqual(runtime.sources[0].descriptor, {
    id: 'workflow_a', active: true, priority: 77, supportsMovies: true,
    supportsEpisodes: false, languages: [], strategy: 'http', timeoutMs: 2500,
    maxCandidates: 4,
  });
  assert.equal(runtime.summary.sourcesRegistered, 1);
});

test('mapped catalog source returns empty without mappings and does not use HTTP', async () => {
  const mappingCalls = [];
  const catalog = loaded({ version: 1, sources: [mappedSource('workflow_a',
    'https://workflow.example.test')] });
  const runtime = buildResolverV2CatalogRuntime({ catalog,
    http: { request: async () => { throw new Error('HTTP must not run without mappings'); } },
    hlsResolver, mappingResolver: { resolve: async (input) => {
      mappingCalls.push(input);
      return [];
    } } });
  const media = Object.freeze({ contentType: 'movie', contentId: 'movie-1', tmdbId: 1,
    title: 'Fixture' });
  assert.deepEqual(await runtime.sources[0].getSources(media, {}), []);
  assert.equal(mappingCalls.length, 1);
  assert.equal(mappingCalls[0].mediaContext, media);
});

test('mapped runtime passes exact media context and resolves local workflow mappings', async (t) => {
  const requests = [];
  const fixture = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: request.url.endsWith('/a') ? {}
      : { url: 'https://media.example.test/ready.m3u8' } }));
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  const calls = [];
  const mappingResolver = { resolve: async (input) => {
    calls.push(input);
    return [mappingRef('a'), mappingRef('b')];
  } };
  const catalog = loaded({ version: 1, sources: [mappedSource('workflow_a', baseUrl)] });
  const runtime = buildResolverV2CatalogRuntime({ catalog,
    http: createSafeHttpClient({ allowPrivateNetworks: true }), hlsResolver, mappingResolver });
  const media = Object.freeze({ contentType: 'movie', contentId: 'movie-1', tmdbId: 1,
    title: 'Fixture' });
  const candidates = await runtime.sources[0].getSources(media, {});
  assert.equal(calls[0].mediaContext, media);
  assert.deepEqual(requests, ['/item/a', '/item/b']);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerId, 'workflow_a');
  assert.equal(candidates[0].url, 'https://media.example.test/ready.m3u8');
});

test('mapped runtime performs bounded text capture before a second deterministic request',
  async (t) => {
    const requests = [];
    const fixture = http.createServer((request, response) => {
      requests.push(request.url);
      if (request.url === '/item/external-7') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<main>PLAYER-ID="public-player-7"</main>');
        return;
      }
      if (request.url === '/player/public-player-7') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"url":"https://media.example.test/text-flow.m3u8"}');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => fixture.close(resolve)));
    const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
    const workflow = [
      { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
      { type: 'extract', from: 'page', parser: 'text', start: 'PLAYER-ID="', end: '"',
        saveAs: 'playerId' },
      { type: 'request', method: 'GET', path: '/player/{playerId}', saveAs: 'payload' },
      { type: 'extract', from: 'payload', parser: 'json', path: 'url', saveAs: 'hls' },
      { type: 'emit', url: '{hls}' },
    ];
    const mappingCalls = [];
    const mappingResolver = { resolve: async (input) => {
      mappingCalls.push(input);
      return [mappingRef('external-7')];
    } };
    const catalog = loaded({ version: 1, sources: [mappedSource('workflow_a', baseUrl,
      { workflow, maxSteps: 5 })] });
    const runtime = buildResolverV2CatalogRuntime({ catalog,
      http: createSafeHttpClient({ allowPrivateNetworks: true }), hlsResolver, mappingResolver });
    const media = Object.freeze({ contentType: 'movie', contentId: 'movie-1', tmdbId: 1,
      title: 'Fixture' });
    const candidates = await runtime.sources[0].getSources(media, {});
    assert.equal(mappingCalls.length, 1);
    assert.equal(mappingCalls[0].mediaContext, media);
    assert.deepEqual(requests, ['/item/external-7', '/player/public-player-7']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'workflow_a');
    assert.equal(candidates[0].url, 'https://media.example.test/text-flow.m3u8');
    assert.deepEqual(candidates[0].headers, {});
    assert.doesNotMatch(JSON.stringify(candidates), /PLAYER-ID|public-player-7|authorization|cookie/i);
  });

test('mapped source skips safely without resolver and duplicate IDs remain protected', () => {
  const payload = { version: 1, sources: [
    mappedSource('workflow_a', 'https://workflow.example.test'),
    source('sibling'),
  ] };
  const catalog = loaded(payload);
  const missing = buildResolverV2CatalogRuntime({ catalog, http: fakeHttp, hlsResolver });
  assert.deepEqual(missing.sources.map(({ descriptor }) => descriptor.id), ['sibling']);
  assert.deepEqual(missing.summary.errorCodes,
    ['MAPPED_SOURCE_MAPPING_RESOLVER_UNAVAILABLE']);
  const duplicate = buildResolverV2CatalogRuntime({ catalog, http: fakeHttp, hlsResolver,
    existingSourceIds: ['workflow_a'], mappingResolver: { resolve: async () => [] } });
  assert.deepEqual(duplicate.sources.map(({ descriptor }) => descriptor.id), ['sibling']);
  assert.deepEqual(duplicate.summary.errorCodes, ['CATALOG_DUPLICATE_SOURCE']);
});

test('existing env IDs and direct_hls cannot be replaced by catalog entries', () => {
  const runtime = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1,
      sources: [source('env_source')],
      resolvers: [resolver('env_resolver'), resolver('direct_hls')],
    }),
    httpProvider: { enabled: true, id: 'env_source', baseUrl: 'https://env.example.test' },
    httpResolver: { enabled: true, id: 'env_resolver', domains: ['env-resolver.example.test'] },
    httpClient: { get: async () => { throw new Error('no request'); },
      head: async () => { throw new Error('no request'); } }, healthEnabled: false });
  assert.equal(runtime.sourceRegistry.list().filter((entry) =>
    entry.descriptor.id === 'env_source').length, 1);
  assert.equal(runtime.resolverRegistry.list().filter((entry) =>
    entry.descriptor.id === 'env_resolver').length, 1);
  assert.equal(runtime.resolverRegistry.get('direct_hls').descriptor.strategy, 'direct');
  assert.deepEqual(runtime.catalogSummary.errorCodes,
    ['CATALOG_DUPLICATE_SOURCE', 'CATALOG_DUPLICATE_RESOLVER',
      'CATALOG_DUPLICATE_RESOLVER']);
});

test('disabled catalog performs no read and failed load preserves built-in runtime', () => {
  let reads = 0;
  const disabled = createShadowPipeline({ catalogEnabled: false,
    catalogReadFile: () => { reads += 1; throw new Error('must not read'); }, healthEnabled: false });
  assert.equal(reads, 0);
  assert.equal(disabled.resolverRegistry.get('direct_hls').descriptor.id, 'direct_hls');
  const failed = createShadowPipeline({ catalogEnabled: true, catalogPath: 'missing.json',
    catalogReadFile: () => { throw new Error('missing'); }, healthEnabled: false });
  assert.equal(failed.resolverRegistry.get('direct_hls').descriptor.id, 'direct_hls');
  assert.deepEqual(failed.catalogSummary.errorCodes, ['CATALOG_READ_FAILED']);
});

test('allowlisted secret reference becomes same-origin bearer without entering summaries', async () => {
  let authorization;
  const env = { STREAM_RESOLVER_V2_SECRET_SOURCE_A: 'super-secret-test' };
  const catalog = loaded({ version: 1, sources: [source('source_a', {
    authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE_A',
  })] }, env);
  const runtime = buildResolverV2CatalogRuntime({ catalog, env, hlsResolver,
    http: { get: async (_url, options) => { authorization = options.headers.authorization;
      return { ok: true, headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"sources":[]}') }; } } });
  await runtime.sources[0].getSources({ contentType: 'movie', contentId: 'x',
    tmdbId: 1, title: 'X' });
  assert.equal(authorization, 'Bearer super-secret-test');
  assert.doesNotMatch(JSON.stringify(runtime.summary), /super-secret-test|SOURCE_A|https?:/);
  assert.doesNotMatch(JSON.stringify(runtime), /super-secret-test/);
});

test('catalog bearer authentication is stripped on a cross-origin redirect', async (t) => {
  let originAuthorization;
  let targetAuthorization;
  const target = http.createServer((request, response) => {
    targetAuthorization = request.headers.authorization;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"sources":[]}');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${target.address().port}`;
  const origin = http.createServer((request, response) => {
    originAuthorization = request.headers.authorization;
    response.writeHead(302, { Location: targetUrl });
    response.end();
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => Promise.all([origin, target].map((server) =>
    new Promise((resolve) => server.close(resolve)))));
  const env = { STREAM_RESOLVER_V2_SECRET_SOURCE_A: 'super-secret-test' };
  const catalog = loaded({ version: 1, sources: [source('source_a', {
    baseUrl: `http://127.0.0.1:${origin.address().port}`,
    authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE_A',
  })] }, env);
  const runtime = buildResolverV2CatalogRuntime({ catalog, env, hlsResolver,
    http: createSafeHttpClient({ allowPrivateNetworks: true }) });
  await runtime.sources[0].getSources({ contentType: 'movie', contentId: 'x',
    tmdbId: 1, title: 'X' });
  assert.equal(originAuthorization, 'Bearer super-secret-test');
  assert.equal(targetAuthorization, undefined);
});
test('missing secret and invalid factory entries skip without blocking valid siblings', () => {
  const catalog = { loaded: true, version: 1, sources: [
    { ...source('missing'), priority: 1, timeoutMs: 2000, maxCandidates: 8,
      supportsMovies: true, supportsEpisodes: true,
      authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_MISSING' },
    { ...source('good'), priority: 1, timeoutMs: 2000, maxCandidates: 8,
      supportsMovies: true, supportsEpisodes: true, authTokenEnv: null },
  ], resolvers: [] };
  const runtime = buildResolverV2CatalogRuntime({ catalog, env: {},
    http: fakeHttp, hlsResolver });
  assert.deepEqual(runtime.sources.map((item) => item.descriptor.id), ['good']);
  assert.deepEqual(runtime.summary.errorCodes, ['CATALOG_MISSING_SECRET']);
});

test('catalog modules cannot load arbitrary code or create transport/browser paths', () => {
  for (const name of ['catalogSchema.js', 'catalogLoader.js', 'catalogRuntimeBuilder.js']) {
    const sourceText = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
      'resolverV2', 'catalog', name), 'utf8');
    assert.doesNotMatch(sourceText,
      /ProviderC|puppeteer|browserSlots|ResolverExecutor|child_process|node:vm|\beval\s*\(|new Function/);
    assert.doesNotMatch(sourceText, /\bfetch\s*\(|http\.get|https\.get|axios/);
    assert.doesNotMatch(sourceText, /require\s*\(\s*[a-zA-Z_$]/);
  }
});
