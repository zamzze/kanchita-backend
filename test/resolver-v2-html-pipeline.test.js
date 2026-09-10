'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://html:html@127.0.0.1:5432/html';
process.env.JWT_SECRET ||= 'html-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'html-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'html-test-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { createPreflightRunner } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');
const { formatPreflightJson } =
  require('../src/modules/streams/resolverV2/preflight/preflightCli');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');

const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8\n';
const media = { contentType: 'movie', contentId: 'm', tmdbId: 550, title: 'Movie' };
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

test('catalog drives Source HTML -> resolver detection -> HTML resolver -> validated HLS', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ host: request.headers.host, url: request.url, headers: request.headers });
    const port = server.address().port;
    if (request.url === '/movie/550') { response.writeHead(200, {
      'Content-Type': 'text/html', 'Set-Cookie': 'session=secret' });
      return response.end(`<iframe src="http://embed.example.test:${port}/e/abc">`); }
    if (request.url === '/e/abc') { response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<video src="http://media.example.test:${port}/master.m3u8">`); }
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(manifest);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  const port = server.address().port;
  const catalog = { version: 1, sources: [{ id: 'html_source', type: 'configured_html',
    enabled: true, baseUrl: `http://source.example.test:${port}`,
    allowedCandidateDomains: ['embed.example.test'] }], resolvers: [{
    id: 'html_resolver', type: 'configured_html', enabled: true,
    domains: ['embed.example.test'], pathPrefixes: ['/e/'],
    allowedMediaDomains: ['media.example.test'], playbackHeaderPolicy: 'none',
  }] };
  const client = createSafeHttpClient({ allowPrivateNetworks: true,
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const runtime = createShadowPipeline({ enabled: true, timeoutMs: 1_000,
    catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog), httpClient: client, healthEnabled: false });
  const result = await runtime.pipeline.resolve(media);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].providerId, 'html_source');
  assert.equal(result.streams[0].resolverId, 'html_resolver');
  assert.equal(result.streams[0].validated, true);
  assert.equal(createPrimaryAcceptanceGate().evaluate(result.streams[0]).code,
    'PRIMARY_ACCEPTED');
  assert.deepEqual(runtime.catalogSummary.errorCodes, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers.cookie, undefined);
  assert.equal(calls[2].headers.cookie, undefined);
  const preflight = await createPreflightRunner({ runtime, catalogEnabled: true })
    .run({ contentType: 'movie', tmdbId: 550 }, { timeoutMs: 2_000 });
  assert.equal(preflight.status, 'ready');
  const output = formatPreflightJson(preflight);
  assert.doesNotMatch(output,
    /source\.example\.test|embed\.example\.test|media\.example\.test|127\.0\.0\.1|localhost|\.m3u8|session=secret|contentId|"title"|"tmdbId"/i);
});

test('header-bound HTML chain validates but primary falls back to legacy once', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    const port = server.address().port;
    if (request.url === '/movie/10') { response.writeHead(200, {
      'Content-Type': 'text/html', 'Set-Cookie': 'private=session' });
      return response.end(`<iframe src="http://embed.example.test:${port}/e/secure">`); }
    if (request.url === '/e/secure') { response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<video src="http://media.example.test:${port}/secure.m3u8">`); }
    const valid = request.headers.referer ===
      `http://embed.example.test:${port}/e/secure`;
    response.writeHead(valid ? 200 : 403,
      { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(valid ? manifest : 'denied');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  const port = server.address().port;
  const catalog = { version: 1, sources: [{ id: 'html_source', type: 'configured_html',
    enabled: true, baseUrl: `http://source.example.test:${port}`,
    allowedCandidateDomains: ['embed.example.test'],
    authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_HTML' }], resolvers: [{
    id: 'html_resolver', type: 'configured_html', enabled: true,
    domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'],
    playbackHeaderPolicy: 'referer',
  }] };
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 1_000, timeoutMs: 1_000, healthEnabled: false,
    catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog),
    catalogEnv: { STREAM_RESOLVER_V2_SECRET_HTML: 'source-secret' },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] }) });
  const legacy = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
  let legacyCalls = 0;
  const processor = createStreamProcessor({
    db: { query: async () => { throw new Error('unexpected DB'); } },
    resolverExecutor: { shutdown: async () => {} }, validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 10, title: 'Fixture' }),
    primaryEnabled: true, primaryRolloutPercent: 100, primaryResolver: runtime.primaryResolver,
    primaryStats: runtime.primaryStats, providerManager: { resolve: async () => {
      legacyCalls += 1; return legacy; } },
    lifecycle: { readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id, title: content.title,
      }) }, stats: { recordReady: async () => {} }, logger: { log: () => {}, warn: () => {} },
  });
  const result = await processor({ content_type: 'movie', content_id: 'fixture',
    job_type: 'resolve' });
  assert.deepEqual(result, legacy);
  assert.equal(legacyCalls, 1);
  assert.equal(runtime.primaryStats.snapshot().headersUnsupported, 1);
  assert.equal(runtime.primaryStats.snapshot().fallbacks, 1);
  assert.equal(requests[0].headers.authorization, 'Bearer source-secret');
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(requests[1].headers.cookie, undefined);
  assert.equal(requests[2].headers.authorization, undefined);
  assert.equal(requests[2].headers.cookie, undefined);
  assert.equal(requests[2].headers.referer,
    `http://embed.example.test:${port}/e/secure`);
});

test('catalog schemas keep existing types and reject executable HTML configuration', () => {
  const { normalizeCatalog } = require('../src/modules/streams/resolverV2/catalog/catalogSchema');
  const valid = normalizeCatalog({ version: 1, sources: [{ id: 'html_source',
    type: 'configured_html', enabled: false, allowedCandidateDomains: ['media.example.test'] }],
  resolvers: [{ id: 'html_resolver', type: 'configured_html', enabled: false,
    domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'] }] });
  assert.equal(valid.sources[0].type, 'configured_html');
  assert.equal(valid.resolvers[0].type, 'configured_html');
  for (const extra of [{ headers: {} }, { cookies: true }, { script: 'x' },
    { browser: true }, { regex: '.*' }]) {
    const result = normalizeCatalog({ version: 1, sources: [{ id: 'x',
      type: 'configured_html', allowedCandidateDomains: ['media.example.test'], ...extra }] });
    assert.equal(result.sources.length, 0);
  }
  for (const policy of ['cookie', '', 'arbitrary']) {
    const result = normalizeCatalog({ version: 1, resolvers: [{ id: 'x',
      type: 'configured_html', domains: ['embed.example.test'],
      allowedMediaDomains: ['media.example.test'], requestHeaderPolicy: policy }] });
    assert.equal(result.resolvers.length, 0);
  }
  for (const domain of ['127.0.0.1', 'localhost', '*.example.test',
    'https://embed.example.test', 'embed.example.test/path']) {
    const result = normalizeCatalog({ version: 1, resolvers: [{ id: 'x',
      type: 'configured_html', domains: [domain],
      allowedMediaDomains: ['media.example.test'] }] });
    assert.equal(result.resolvers.length, 0);
  }
});
