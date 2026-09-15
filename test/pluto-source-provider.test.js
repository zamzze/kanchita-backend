'use strict';

const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://test.invalid/test';
process.env.JWT_SECRET ||= 'unused-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'unused-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'unused-test-tmdb-key';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } = require('../src/modules/streams/resolverV2/resolverEngine');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPreflightRunner } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');
const {
  ERROR_CODES,
  createPlutoSourceProvider,
  normalizeMediaMap,
} = require('../src/modules/streams/resolverV2/providers/plutoSourceProvider');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const hls = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nmedia.m3u8\n';
const jwt = 'header.' + Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url') + '.sig';

test('Pluto media map is explicit, bounded and first-valid-wins', () => {
  const map = normalizeMediaMap([
    { contentType: 'movie', tmdbId: 1, plutoId: 'movie123' },
    { contentType: 'movie', tmdbId: 1, plutoId: 'ignored123' },
    { contentType: 'episode', tmdbId: 2, season: 1, episode: 3, plutoId: 'episode123' },
  ]);
  assert.equal(map.length, 2);
  assert.equal(map[0].plutoId, 'movie123');
  assert.equal(normalizeMediaMap([{ contentType: 'movie', tmdbId: 0,
    plutoId: 'movie123' }]), null);
  assert.equal(normalizeMediaMap([{ contentType: 'movie', tmdbId: 1,
    plutoId: 'bad space' }]), null);
  assert.equal(normalizeMediaMap([{ contentType: 'movie', tmdbId: 1,
    plutoId: 'movie123', title: 'No fuzzy matching' }]), null);
  assert.equal(normalizeMediaMap(Array.from({ length: 257 }, () => ({}))), null);
});

test('Pluto provider performs no network request without an exact mapping', async () => {
  let requests = 0;
  const provider = createPlutoSourceProvider({
    enabled: true,
    baseUrl: 'https://service-vod.example.test',
    bootUrl: 'https://boot.example.test/start',
    http: { get: async () => { requests += 1; throw new Error('unexpected'); } },
    mediaMap: [{ contentType: 'movie', tmdbId: 550, plutoId: 'movie123' }],
  });
  assert.deepEqual(await provider.getSources({ contentType: 'movie', tmdbId: 551 }), []);
  assert.equal(requests, 0);
});

test('Pluto provider boots anonymously, fetches only the exact mapped movie and emits HLS', async () => {
  let bootCount = 0;
  let itemCount = 0;
  let catalogCount = 0;
  let authorization;
  let bootUrl = '';
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      bootCount += 1;
      bootUrl = request.url;
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: 'region=fixture' }));
    }
    if (request.url.startsWith('/v4/vod/items')) {
      itemCount += 1;
      authorization = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      assert.equal(new URL(request.url, origin(server)).searchParams.get('ids'), 'movie123');
      return response.end(JSON.stringify([
        { _id: 'movie123', name: 'PRIVATE TITLE',
          stitched: { path: '/stitch/hls/episode/movie123/master.m3u8' } },
      ]));
    }
    if (request.url.includes('/categories')) {
      catalogCount += 1;
      response.statusCode = 500;
      return response.end();
    }
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end(hls);
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const provider = createPlutoSourceProvider({
      id: 'pluto_test', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: client,
      mediaMap: [{ contentType: 'movie', tmdbId: 550, plutoId: 'movie123' }],
    });
    const candidates = await provider.getSources({ contentType: 'movie', tmdbId: 550 },
      { http: client });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'pluto_test');
    assert.deepEqual(candidates[0].headers, {});
    assert.deepEqual(candidates[0].metadata, { sourceType: 'pluto' });
    assert.equal(candidates[0].urlSensitivity, 'temporary_signed');
    assert.equal(typeof candidates[0].expiresAt, 'string');
    assert.match(bootUrl, /deviceType=web/);
    assert.equal(authorization, `Bearer ${jwt}`);
    assert.equal(bootCount, 1);
    assert.equal(itemCount, 1);
    assert.equal(catalogCount, 0);
    await provider.getSources({ contentType: 'movie', tmdbId: 550 }, { http: client });
    assert.equal(bootCount, 1);
    assert.equal(itemCount, 2);
    assert.doesNotMatch(JSON.stringify(candidates), /PRIVATE TITLE|Bearer|sessionToken/);
  } finally { await close(server); }
});

test('Pluto provider supports explicit episode mapping without title search', async () => {
  let itemRequests = 0;
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/boot')) return response.end(JSON.stringify({ sessionToken: jwt,
      servers: { stitcher: origin(server) }, stitcherParams: '' }));
    itemRequests += 1;
    assert.equal(new URL(request.url, origin(server)).searchParams.get('ids'), 'episode123');
    response.end(JSON.stringify([{ id: 'episode123', type: 'episode',
      stitched: { path: '/stitch/hls/episode/episode123/master.m3u8' } }]));
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const provider = createPlutoSourceProvider({
      id: 'pluto_ep', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: client,
      mediaMap: [{ contentType: 'episode', tmdbId: 10, season: 1,
        episode: 2, plutoId: 'episode123' }],
    });
    assert.deepEqual(await provider.getSources({ contentType: 'episode', tmdbId: 10,
      season: 1, episode: 1 }), []);
    const candidates = await provider.getSources({ contentType: 'episode', tmdbId: 10,
      season: 1, episode: 2 });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].url, /\/v2\/stitch\/hls\/episode\/episode123\/master\.m3u8/);
    assert.equal(itemRequests, 1);
  } finally { await close(server); }
});

test('Pluto status and malformed response semantics fail closed', async () => {
  const server = await listen((request, response) => {
    const path = request.url;
    if (path.startsWith('/boot-bad')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{}');
    }
    if (path.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: '' }));
    }
    if (path.includes('unauthorized')) { response.statusCode = 401; return response.end(); }
    if (path.includes('forbidden')) { response.statusCode = 403; return response.end(); }
    if (path.includes('missing')) { response.statusCode = 404; return response.end(); }
    response.setHeader('content-type', 'application/json');
    if (path.includes('badjson')) return response.end('{bad');
    if (path.includes('no-hls')) return response.end(JSON.stringify([
      { _id: 'movie123', stitched: { urls: [] } },
    ]));
    response.end(JSON.stringify({ wrong: [] }));
  });
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const make = (suffix, bootSuffix = 'boot') => createPlutoSourceProvider({
    id: `pluto_${suffix.replaceAll('-', '_')}`, enabled: true,
    baseUrl: `${origin(server)}/${suffix}`, bootUrl: `${origin(server)}/${bootSuffix}`,
    http: client, mediaMap: [{ contentType: 'movie', tmdbId: 1, plutoId: 'movie123' }],
  });
  try {
    assert.deepEqual(await make('missing').getSources({ contentType: 'movie', tmdbId: 1 }), []);
    assert.deepEqual(await make('no-hls').getSources({ contentType: 'movie', tmdbId: 1 }), []);
    assert.deepEqual(await make('invalid').getSources({ contentType: 'movie', tmdbId: 1 }), []);
    await assert.rejects(make('forbidden').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: ERROR_CODES.HTTP_ERROR });
    await assert.rejects(make('unauthorized').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: ERROR_CODES.HTTP_ERROR });
    await assert.rejects(make('badjson').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: ERROR_CODES.INVALID_JSON });
    await assert.rejects(make('ok', 'boot-bad').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: ERROR_CODES.INVALID_RESPONSE });
  } finally { await close(server); }
});

test('Pluto provider propagates timeout and abort through SafeHttpClient', async () => {
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: '' }));
    }
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end('{"categories":[]}');
    }, 300);
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const provider = createPlutoSourceProvider({
      id: 'pluto_slow', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: client, timeoutMs: 100,
      mediaMap: [{ contentType: 'movie', tmdbId: 1, plutoId: 'movie123' }],
    });
    await assert.rejects(provider.getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: 'HTTP_TIMEOUT' });

    const controller = new AbortController();
    controller.abort();
    const aborted = createPlutoSourceProvider({
      id: 'pluto_abort', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: client,
      mediaMap: [{ contentType: 'movie', tmdbId: 1, plutoId: 'movie123' }],
    });
    await assert.rejects(aborted.getSources({ contentType: 'movie', tmdbId: 1 },
      { signal: controller.signal }), { code: 'HTTP_ABORTED' });
  } finally { await close(server); }
});

test('Pluto exact item provider composes DirectHlsResolver, preflight and primary', async () => {
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: '' }));
    }
    if (request.url.startsWith('/v4/vod/items')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify([
        { _id: 'movie123', stitched: { path: '/stitch/hls/episode/movie123/master.m3u8' } },
      ]));
    }
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end(hls);
  });
  const entry = { id: 'pluto_catalog', type: 'pluto', enabled: true,
    baseUrl: origin(server), bootUrl: `${origin(server)}/boot`, priority: 100,
    timeoutMs: 2000, maxCandidates: 2,
    mediaMap: [{ contentType: 'movie', tmdbId: 550, plutoId: 'movie123' }] };
  try {
    const normalized = normalizeCatalog({ version: 1, sources: [entry], resolvers: [] });
    assert.equal(normalized.sources[0].type, 'pluto');
    for (const forbidden of ['headers', 'authTokenEnv', 'browser', 'script']) {
      assert.equal(normalizeCatalog({ version: 1,
        sources: [{ ...entry, [forbidden]: {} }], resolvers: [] }).sources.length, 0);
    }
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const direct = createDirectHlsResolver({ httpClient: client, timeoutMs: 3000 });
    const runtime = createShadowPipeline({
      httpClient: client, catalogEnabled: true, catalogPath: 'fixture.json',
      catalogReadFile: () => Buffer.from(JSON.stringify({
        version: 1, sources: [entry], resolvers: [],
      })), enabled: false, primaryEnabled: true, timeoutMs: 3000,
      primaryTimeoutMs: 3000,
    });
    const built = buildResolverV2CatalogRuntime({
      catalog: { loaded: true, version: 1, sources: normalized.sources, resolvers: [] },
      http: client, hlsResolver: direct,
    });
    assert.equal(built.sources[0].descriptor.id, 'pluto_catalog');
    const result = await createPreflightRunner({ runtime, catalogEnabled: true })
      .run({ contentType: 'movie', tmdbId: 550 }, { timeoutMs: 3000 });
    assert.equal(result.status, 'ready');
    assert.equal(result.acceptanceSummary.accepted, true);
    assert.doesNotMatch(JSON.stringify(result), /movie123|sessionToken|Bearer|127\.0\.0\.1/);
    const primary = await runtime.primaryResolver.resolve({
      contentType: 'movie', contentId: 'fixture', tmdbId: 550, title: 'fixture',
    });
    assert.equal(primary.status, 'accepted');
    assert.equal(primary.selected.providerId, 'pluto_catalog');
  } finally { await close(server); }
});

test('Pluto provider has no browser, legacy, direct transport or persistent-cookie coupling', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/providers/plutoSourceProvider'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|browserSlots|ProviderC|ResolverExecutor|child_process|linkExtractor|\bfetch\s*\(|http\.get|https\.get|axios|CookieJar|set-cookie/i);
  assert.doesNotMatch(source, /v3\/vod\/categories|includeItems=true/i);
  assert.match(source, /\/v4\/vod\/items/);
});
