'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://chain:chain@127.0.0.1:5432/chain';
process.env.JWT_SECRET ||= 'chain-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'chain-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'chain-test-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } = require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPreflightRunner } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');
const { formatPreflightJson } =
  require('../src/modules/streams/resolverV2/preflight/preflightCli');
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');

const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8\n';
const media = { contentType: 'movie', contentId: 'm', tmdbId: 10, title: 'Movie' };
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const client = () => createSafeHttpClient({ allowPrivateNetworks: true,
  dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] });
const runtimeFor = (port, playbackHeaderPolicy = 'none') => {
  const catalog = { version: 1, sources: [{ id: 'html_source', type: 'configured_html',
    enabled: true, baseUrl: `http://source.example.test:${port}`,
    allowedCandidateDomains: ['a.example.test'],
    authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_CHAIN' }], resolvers: [{
    id: 'resolver_a', type: 'configured_html', enabled: true, domains: ['a.example.test'],
    allowedMediaDomains: ['media.example.test'], allowedNestedDomains: ['b.example.test'],
  }, { id: 'resolver_b', type: 'configured_html', enabled: true,
    domains: ['b.example.test'], allowedMediaDomains: ['media.example.test'],
    playbackHeaderPolicy }] };
  return createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 1_500, timeoutMs: 1_500, healthEnabled: false,
    catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog),
    catalogEnv: { STREAM_RESOLVER_V2_SECRET_CHAIN: 'source-secret' }, httpClient: client() });
};

test('two-hop HTML chain preserves immediate parent headers and is preflight-ready', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    const port = server.address().port;
    const html = (body, cookie) => { response.writeHead(200,
      { 'Content-Type': 'text/html', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
      response.end(body); };
    if (request.url === '/movie/10') return html(
      `<iframe src="http://a.example.test:${port}/a">`, 's=one');
    if (request.url === '/a') return html(
      `<iframe src="http://b.example.test:${port}/b">`, 'a=two');
    if (request.url === '/b') return html(
      `<video src="http://media.example.test:${port}/master.m3u8">`, 'b=three');
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(manifest);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  const runtime = runtimeFor(server.address().port);
  const result = await runtime.pipeline.resolve(media);
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.streams[0].headers, {});
  assert.equal(createPrimaryAcceptanceGate().evaluate(result.streams[0]).code,
    'PRIMARY_ACCEPTED');
  assert.equal(calls[0].headers.authorization, 'Bearer source-secret');
  assert.equal(calls[1].headers.referer,
    `http://source.example.test:${server.address().port}/movie/10`);
  assert.equal(calls[2].headers.referer, `http://a.example.test:${server.address().port}/a`);
  assert.equal(calls[3].headers.referer, undefined);
  assert.equal(calls.slice(1).some(({ headers }) => headers.authorization || headers.cookie), false);
  const preflight = await createPreflightRunner({ runtime, catalogEnabled: true }).run(
    { contentType: 'movie', tmdbId: 10 }, { timeoutMs: 2_000 });
  assert.equal(preflight.status, 'ready');
  assert.ok(preflight.resolverSummary.attempted >= 2);
  assert.doesNotMatch(formatPreflightJson(preflight),
    /source\.example|a\.example|b\.example|media\.example|127\.0\.0\.1|source-secret|\.m3u8/i);
  let legacyCalls = 0;
  const processor = createStreamProcessor({ db: { query: async () => {} },
    resolverExecutor: { shutdown: async () => {} }, validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 10, title: 'Movie' }), primaryEnabled: true,
    primaryRolloutPercent: 100, primaryResolver: runtime.primaryResolver,
    primaryStats: runtime.primaryStats, providerManager: { resolve: async () => {
      legacyCalls += 1;
      return { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
    } }, lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({ contentType: 'movie',
        contentId: 'm', tmdbId: content.tmdb_id, title: content.title }),
    }, stats: { recordReady: async () => {} },
    logger: { log: () => {}, warn: () => {} } });
  const primaryResult = await processor(
    { content_type: 'movie', content_id: 'm', job_type: 'resolve' });
  assert.equal(primaryResult.provider, 'html_source');
  assert.equal(legacyCalls, 0);
});

test('HTTP cycle A to B to A terminates after one request per resolver node', async (t) => {
  const counts = { source: 0, a: 0, b: 0 };
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    if (request.url === '/movie/10') { counts.source += 1;
      return response.end(`<iframe src="http://a.example.test:${port}/a">`); }
    if (request.url === '/a') { counts.a += 1;
      return response.end(`<iframe src="http://b.example.test:${port}/b">`); }
    counts.b += 1;
    response.end(`<iframe src="http://a.example.test:${port}/a">`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  const port = server.address().port;
  const catalog = { version: 1, sources: [{ id: 'html_source', type: 'configured_html',
    enabled: true, baseUrl: `http://source.example.test:${port}`,
    allowedCandidateDomains: ['a.example.test'] }], resolvers: [{ id: 'a',
    type: 'configured_html', enabled: true, domains: ['a.example.test'],
    allowedMediaDomains: ['media.example.test'], allowedNestedDomains: ['b.example.test'] },
  { id: 'b', type: 'configured_html', enabled: true, domains: ['b.example.test'],
    allowedMediaDomains: ['media.example.test'], allowedNestedDomains: ['a.example.test'] }] };
  const runtime = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog), httpClient: client(), healthEnabled: false });
  const result = await runtime.pipeline.resolve(media);
  assert.equal(result.streams.length, 0);
  assert.deepEqual(counts, { source: 1, a: 1, b: 1 });
  assert.equal(result.resolverTrace.nodesSkippedVisited, 1);
});

test('header-bound final hop validates then primary falls back to legacy exactly once', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    const port = server.address().port;
    response.setHeader('Set-Cookie', `cookie=${request.url}`);
    if (request.url === '/movie/10') { response.setHeader('Content-Type', 'text/html');
      return response.end(`<iframe src="http://a.example.test:${port}/a">`); }
    if (request.url === '/a') { response.setHeader('Content-Type', 'text/html');
      return response.end(`<iframe src="http://b.example.test:${port}/b">`); }
    if (request.url === '/b') { response.setHeader('Content-Type', 'text/html');
      return response.end(`<video src="http://media.example.test:${port}/secure.m3u8">`); }
    const valid = request.headers.referer === `http://b.example.test:${port}/b`;
    response.writeHead(valid ? 200 : 403,
      { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(valid ? manifest : 'denied');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  const runtime = runtimeFor(server.address().port, 'referer');
  const legacy = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
  let legacyCalls = 0;
  const processor = createStreamProcessor({ db: { query: async () => {} },
    resolverExecutor: { shutdown: async () => {} }, validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 10, title: 'Movie' }), primaryEnabled: true,
    primaryRolloutPercent: 100, primaryResolver: runtime.primaryResolver,
    primaryStats: runtime.primaryStats, providerManager: { resolve: async () => {
      legacyCalls += 1; return legacy; } }, lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({ contentType: 'movie',
        contentId: 'm', tmdbId: content.tmdb_id, title: content.title }) },
    stats: { recordReady: async () => {} }, logger: { log: () => {}, warn: () => {} } });
  const result = await processor({ content_type: 'movie', content_id: 'm', job_type: 'resolve' });
  assert.deepEqual(result, legacy);
  assert.equal(legacyCalls, 1);
  assert.equal(runtime.primaryStats.snapshot().headersUnsupported, 1);
  assert.equal(calls.at(-1).headers.referer, `http://b.example.test:${server.address().port}/b`);
  assert.equal(calls.slice(1).some(({ headers }) => headers.authorization || headers.cookie), false);
});
