'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://preflight:preflight@127.0.0.1:5432/preflight';
process.env.JWT_SECRET ||= 'preflight-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'preflight-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'preflight-test-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPreflightRunner } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');
const { exitCodeForStatus, formatPreflightJson, formatPreflightText } =
  require('../src/modules/streams/resolverV2/preflight/preflightCli');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const sourceEntry = (id, baseUrl) => ({ id, type: 'configured_http', enabled: true,
  priority: 100, baseUrl, timeoutMs: 1000, maxCandidates: 8 });
const makeRuntime = (catalog, httpClient = createSafeHttpClient({ allowPrivateNetworks: true })) =>
  createShadowPipeline({ enabled: false, primaryEnabled: false, timeoutMs: 2000,
    catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog), catalogEnv: {}, httpClient,
    logger: { log: () => {}, warn: () => {}, error: () => {} } });
const run = (runtime, input = { contentType: 'movie', tmdbId: 550 }) =>
  createPreflightRunner({ runtime, catalogEnabled: true }).run(input, { timeoutMs: 2000 });

test('preflight multi-provider direct HLS uses real ranking and accepts Latino', async (t) => {
  const manifest = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const specs = [
    ['source_a', 'en', '1080p'], ['source_b', 'es-419', '720p'],
    ['source_c', 'es', '1080p'],
  ];
  const sources = [];
  for (const [id, language, quality] of specs) {
    const source = await listen((_request, response) => json(response, { sources: [{
      url: `${manifest.url}/${id}.m3u8`, language, quality,
    }] }));
    sources.push({ id, source });
  }
  t.after(() => Promise.all([manifest, ...sources.map(({ source }) => source)]
    .map(({ server }) => close(server))));
  const runtime = makeRuntime({ version: 1,
    sources: sources.map(({ id, source }) => sourceEntry(id, source.url)) });
  const result = await run(runtime);
  assert.equal(result.status, 'ready');
  assert.equal(exitCodeForStatus(result.status), 0);
  assert.equal(result.sourceSummary.attempted, 3);
  assert.equal(result.sourceSummary.succeeded, 3);
  assert.equal(result.rankingSummary.streamCount, 3);
  assert.equal(result.rankingSummary.selected.languageTier, 'latino');
  assert.equal(result.rankingSummary.selected.qualityTier, '720p');
  assert.equal(result.acceptanceSummary.accepted, true);
  assert.equal(result.resolverSummary.succeeded, 3);
  assert.doesNotMatch(formatPreflightJson(result), /127\.0\.0\.1|source_[abc]|\.m3u8/);
});

test('preflight configured resolver path reaches validated HLS without legacy', async (t) => {
  const manifest = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const resolver = await listen((_request, response) => json(response, { streams: [{
    url: `${manifest.url}/resolved.m3u8`, protocol: 'hls', quality: '1080p',
    audioLanguage: 'es-419', providerId: 'remote_fake', resolverId: 'remote_fake',
  }] }));
  const source = await listen((_request, response) => json(response, { sources: [{
    url: `${resolver.url}/resolve/550`, providerId: 'remote_fake',
  }] }));
  t.after(() => Promise.all([manifest, resolver, source].map(({ server }) => close(server))));
  const runtime = makeRuntime({ version: 1,
    sources: [sourceEntry('source_a', source.url)],
    resolvers: [{ id: 'resolver_a', type: 'configured_http', enabled: true,
      priority: 2000, domains: ['127.0.0.1'], pathPrefixes: ['/resolve/'],
      timeoutMs: 1000, maxStreams: 4 }],
  });
  const result = await run(runtime);
  assert.equal(result.status, 'ready');
  assert.equal(result.acceptanceSummary.accepted, true);
  assert.equal(result.rankingSummary.selected.protocolTier, 'hls');
  assert.equal(result.resolverSummary.succeeded, 1);
  assert.doesNotMatch(formatPreflightText(result), /127\.0\.0\.1|remote_fake|source_a|resolver_a/);
});

test('preflight reports header-bound HLS as rejected without exposing headers', async (t) => {
  const manifest = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const source = await listen((_request, response) => json(response, { sources: [{
    url: `${manifest.url}/header-bound.m3u8`, language: 'es-419',
    headers: { Referer: 'https://very-secret-host.example.test/?token=XYZ' },
  }] }));
  t.after(() => Promise.all([manifest, source].map(({ server }) => close(server))));
  const result = await run(makeRuntime({ version: 1,
    sources: [sourceEntry('source_a', source.url)] }));
  assert.equal(result.status, 'rejected');
  assert.equal(exitCodeForStatus(result.status), 3);
  assert.equal(result.acceptanceSummary.code, 'PRIMARY_HEADERS_UNSUPPORTED');
  assert.equal(result.acceptanceSummary.headersSupported, false);
  for (const output of [formatPreflightJson(result), formatPreflightText(result)]) {
    assert.doesNotMatch(output, /Referer|very-secret-host|XYZ|token|127\.0\.0\.1/i);
  }
});

test('invalid manifest is never promoted and single-env provider remains supported', async (t) => {
  const invalid = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html>private body</html>');
  });
  const source = await listen((_request, response) => json(response, { sources: [{
    url: `${invalid.url}/invalid.m3u8`,
  }] }));
  t.after(() => Promise.all([invalid, source].map(({ server }) => close(server))));
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: false, timeoutMs: 2000,
    catalogEnabled: false, httpProvider: { enabled: true, id: 'env_source',
      baseUrl: source.url }, httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const result = await createPreflightRunner({ runtime, catalogEnabled: false })
    .run({ contentType: 'movie', tmdbId: 550 }, { timeoutMs: 2000 });
  assert.equal(result.status, 'no_streams');
  assert.equal(exitCodeForStatus(result.status), 3);
  assert.equal(result.rankingSummary.streamCount, 0);
  assert.doesNotMatch(formatPreflightJson(result), /private body|html|127\.0\.0\.1/);
});

test('catalog-only composes the real registries without performing HTTP', async () => {
  let calls = 0;
  const httpClient = {
    get: async () => { calls += 1; throw new Error('network forbidden'); },
    head: async () => { calls += 1; throw new Error('network forbidden'); },
  };
  const runtime = makeRuntime({ version: 1,
    sources: [sourceEntry('source_a', 'https://source.example.test')],
    resolvers: [{ id: 'resolver_a', type: 'configured_http', enabled: true,
      domains: ['resolver.example.test'], pathPrefixes: ['/resolve/'] }],
  }, httpClient);
  const result = await createPreflightRunner({ runtime, catalogEnabled: true })
    .run(null, { catalogOnly: true, timeoutMs: 2000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.catalog.loaded, true);
  assert.equal(result.catalog.sourcesRegistered, 1);
  assert.equal(result.catalog.resolversRegistered, 1);
  assert.equal(calls, 0);
});

test('production transport rejects private destinations without leaking them', async () => {
  const runtime = makeRuntime({ version: 1,
    sources: [sourceEntry('source_a', 'http://127.0.0.1:9')] },
  createSafeHttpClient());
  const result = await run(runtime);
  assert.equal(result.status, 'no_candidates');
  assert.equal(result.sourceSummary.failed, 1);
  assert.doesNotMatch(formatPreflightJson(result), /127\.0\.0\.1|UNSAFE_DESTINATION|source_a/);
});
