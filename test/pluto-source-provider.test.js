'use strict';

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');

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
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { runMigrations } = require('../database/migrate');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { createProviderMediaMappingResolver } =
  require('../src/modules/streams/providerMediaMappingResolver');
const {
  DEFAULT_MAX_MAPPING_ATTEMPTS,
  ERROR_CODES,
  HARD_MAX_MAPPING_ATTEMPTS,
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
const TEST_DB_URL = process.env.TEST_DB_URL;
const mappingRef = (externalId, overrides = {}) => ({
  mappingId: 1,
  providerId: 'pluto',
  region: 'latam',
  contentType: 'movie',
  tmdbId: 550,
  externalId,
  seasonNumber: null,
  episodeNumber: null,
  providerTitle: null,
  providerSlug: null,
  matchMethod: 'manual',
  matchConfidence: 100,
  metadata: {},
  lastVerifiedAt: null,
  ...overrides,
});

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

test('Pluto DB mapping hit resolves exact movie while misses stay network-free', async () => {
  const externalId = '0123456789abcdef01234567';
  let bootRequests = 0;
  let itemRequests = 0;
  let catalogRequests = 0;
  const lookups = [];
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      bootRequests += 1;
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: '' }));
    }
    if (request.url.startsWith('/v4/vod/items')) {
      itemRequests += 1;
      assert.equal(new URL(request.url, origin(server)).searchParams.get('ids'), externalId);
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify([{ _id: externalId,
        stitched: { path: `/stitch/hls/episode/${externalId}/master.m3u8` } }]));
    }
    if (/catalog|categor|search|series|season/i.test(request.url)) catalogRequests += 1;
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end(hls);
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const mappingStore = { findActiveMapping: async (lookup) => {
      lookups.push(lookup);
      return lookup.tmdbId === 550 ? { external_id: externalId, status: 'active' }
        : lookup.tmdbId === 552 ? { external_id: externalId, status: 'inactive' } : null;
    } };
    const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
      region: 'latam', baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
      http: client, mappingStore, mediaMap: [] });
    assert.deepEqual(await provider.getSources({ contentType: 'movie', tmdbId: 551 }), []);
    assert.deepEqual(await provider.getSources({ contentType: 'movie', tmdbId: 552 }), []);
    assert.equal(bootRequests, 0);
    assert.equal(itemRequests, 0);
    const candidates = await provider.getSources({ contentType: 'movie', tmdbId: 550 });
    assert.equal(candidates.length, 1);
    assert.deepEqual(lookups, [
      { providerId: 'pluto', region: 'latam', contentType: 'movie', tmdbId: 551 },
      { providerId: 'pluto', region: 'latam', contentType: 'movie', tmdbId: 552 },
      { providerId: 'pluto', region: 'latam', contentType: 'movie', tmdbId: 550 },
    ]);
    const resolved = await createResolverEngine({ registry: createResolverRegistry([
      createDirectHlsResolver({ httpClient: client }),
    ]) }).resolve({ mediaContext: { contentType: 'movie', contentId: 'movie-id',
      tmdbId: 550, title: 'Mapped movie' }, candidates });
    assert.equal(resolved.streams[0].validated, true);
    assert.equal(bootRequests, 1);
    assert.equal(itemRequests, 1);
    assert.equal(catalogRequests, 0);
  } finally { await close(server); }
});

test('Pluto mapping resolver preserves identity and missing mappings remain network-free',
  async () => {
    let requests = 0;
    const lookups = [];
    const mappingResolver = { resolve: async (lookup) => {
      lookups.push(structuredClone(lookup));
      return lookup.mediaContext.tmdbId === 550 ? [mappingRef('movie123')] : [];
    } };
    const server = await listen((request, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
        sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
      }));
      assert.equal(new URL(request.url, origin(server)).searchParams.get('ids'), 'movie123');
      response.end(JSON.stringify([{ _id: 'movie123',
        stitched: { path: '/stitch/hls/episode/movie123/master.m3u8' } }]));
    });
    try {
      const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
        baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
        http: createSafeHttpClient({ allowPrivateNetworks: true }), mappingResolver,
        mappingStore: { findActiveMapping: async () => {
          throw new Error('legacy store must not run when mappingResolver is present');
        } } });
      assert.deepEqual(await provider.getSources({ contentType: 'movie', tmdbId: 551 }), []);
      assert.equal(requests, 0);
      assert.equal((await provider.getSources({ contentType: 'movie', tmdbId: 550 })).length, 1);
      assert.deepEqual(lookups, [
        { providerId: 'pluto', region: 'latam',
          mediaContext: { contentType: 'movie', tmdbId: 551 } },
        { providerId: 'pluto', region: 'latam',
          mediaContext: { contentType: 'movie', tmdbId: 550 } },
      ]);
      assert.equal(requests, 2);
    } finally { await close(server); }
  });

test('PostgreSQL mapping resolves through Pluto exact item into an EmbedCandidate', {
  skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run Pluto mapping integration test',
}, async () => {
  const externalId = '0123456789abcdef01234567';
  const schema = `kanchita_pluto_mapping_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DB_URL });
  let db;
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
      sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
    }));
    assert.equal(new URL(request.url, origin(server)).searchParams.get('ids'), externalId);
    response.end(JSON.stringify([{ _id: externalId,
      stitched: { path: `/stitch/hls/episode/${externalId}/master.m3u8` } }]));
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new Pool({ connectionString: TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    await runMigrations({ pool: db, logger: { log() {} } });
    const store = createProviderMediaMappingStore(db);
    await store.upsertMapping({ providerId: 'pluto', region: 'latam', contentType: 'movie',
      tmdbId: 550, externalId, matchMethod: 'manual', status: 'active' });
    const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
      baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
      http: createSafeHttpClient({ allowPrivateNetworks: true }),
      mappingResolver: createProviderMediaMappingResolver({ store }) });
    const candidates = await provider.getSources({ contentType: 'movie', tmdbId: 550 });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'pluto');
    assert.equal(candidates[0].urlSensitivity, 'temporary_signed');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
    await close(server);
  }
});

test('Pluto tries ordered mappings sequentially with one boot and first-valid success',
  async () => {
    const itemIds = [];
    let bootRequests = 0;
    const refs = [mappingRef('missing1', { mappingId: 1 }),
      mappingRef('nohls01', { mappingId: 2 }),
      mappingRef('success1', { mappingId: 3 })];
    const server = await listen((request, response) => {
      if (request.url.startsWith('/boot')) {
        bootRequests += 1;
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ sessionToken: jwt,
          servers: { stitcher: origin(server) }, stitcherParams: '' }));
      }
      const itemId = new URL(request.url, origin(server)).searchParams.get('ids');
      itemIds.push(itemId);
      if (itemId === 'missing1') { response.statusCode = 404; return response.end(); }
      response.setHeader('content-type', 'application/json');
      if (itemId === 'nohls01') return response.end(JSON.stringify([{ _id: itemId }]));
      response.end(JSON.stringify([{ _id: itemId,
        stitched: { path: `/stitch/hls/episode/${itemId}/master.m3u8` } }]));
    });
    try {
      const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
        baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
        http: createSafeHttpClient({ allowPrivateNetworks: true }),
        mappingResolver: { resolve: async () => refs } });
      const candidates = await provider.getSources({ contentType: 'movie', tmdbId: 550 });
      assert.equal(candidates.length, 1);
      assert.match(candidates[0].url, /success1/);
      assert.deepEqual(itemIds, ['missing1', 'nohls01', 'success1']);
      assert.equal(bootRequests, 1);
    } finally { await close(server); }
  });

test('Pluto mapping attempt budget is bounded and malformed refs cause no item request',
  async () => {
    const itemIds = [];
    const refs = [mappingRef('invalid1', { mappingId: 0 }),
      mappingRef('first01', { mappingId: 2 }), mappingRef('second1', { mappingId: 3 }),
      mappingRef('beyond1', { mappingId: 4 })];
    const server = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
        sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
      }));
      itemIds.push(new URL(request.url, origin(server)).searchParams.get('ids'));
      response.statusCode = 404;
      response.end();
    });
    try {
      const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
        baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
        http: createSafeHttpClient({ allowPrivateNetworks: true }), maxMappingAttempts: 3,
        mappingResolver: { resolve: async () => refs } });
      assert.deepEqual(await provider.getSources({ contentType: 'movie', tmdbId: 550 }), []);
      assert.deepEqual(itemIds, ['first01', 'second1']);
      assert.equal(DEFAULT_MAX_MAPPING_ATTEMPTS, 3);
      assert.equal(HARD_MAX_MAPPING_ATTEMPTS, 8);
      for (const maxMappingAttempts of [0, 9, 1.5, Infinity, '3']) {
        assert.throws(() => createPlutoSourceProvider({ enabled: false,
          maxMappingAttempts }), { code: ERROR_CODES.INVALID_CONFIG });
      }
      assert.throws(() => createPlutoSourceProvider({ enabled: false,
        mappingResolver: {} }), { code: ERROR_CODES.INVALID_CONFIG });
    } finally { await close(server); }
  });

test('Pluto mapping resolver supports exact episodes without catalog hierarchy requests',
  async () => {
    const paths = [];
    const lookups = [];
    const server = await listen((request, response) => {
      paths.push(new URL(request.url, origin(server)).pathname);
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
        sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
      }));
      assert.equal(paths.at(-1), '/v2/episodes/episode123/clips.json');
      response.end(JSON.stringify({ clips: [{ id: 'clip123' }] }));
    });
    try {
      const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
        baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
        http: createSafeHttpClient({ allowPrivateNetworks: true }),
        mappingResolver: { resolve: async (lookup) => {
          lookups.push(structuredClone(lookup));
          return [mappingRef('episode123', { contentType: 'episode', tmdbId: 10,
            seasonNumber: 1, episodeNumber: 2 })];
        } } });
      const candidates = await provider.getSources({ contentType: 'episode', tmdbId: 10,
        season: 1, episode: 2 });
      assert.equal(candidates.length, 1);
      assert.match(candidates[0].url, /\/v2\/stitch\/hls\/episode\/episode123/);
      assert.deepEqual(lookups, [{ providerId: 'pluto', region: 'latam',
        mediaContext: { contentType: 'episode', tmdbId: 10, season: 1, episode: 2 } }]);
      assert.equal(paths.filter((path) => /catalog|search|series|season/i.test(path)).length, 0);
    } finally { await close(server); }
  });

test('Pluto mediaMap and diagnostic IDs take precedence over mapping resolver', async () => {
  const itemIds = [];
  let resolverCalls = 0;
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
      sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
    }));
    const itemId = new URL(request.url, origin(server)).searchParams.get('ids');
    itemIds.push(itemId);
    response.end(JSON.stringify([{ _id: itemId,
      stitched: { path: `/stitch/hls/episode/${itemId}/master.m3u8` } }]));
  });
  try {
    const options = { id: 'pluto', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: createSafeHttpClient({ allowPrivateNetworks: true }),
      mappingResolver: { resolve: async () => { resolverCalls += 1;
        return [mappingRef('resolver1')]; } } };
    const configured = createPlutoSourceProvider({ ...options,
      mediaMap: [{ contentType: 'movie', tmdbId: 550, plutoId: 'mapped01' }] });
    assert.equal((await configured.getSources({ contentType: 'movie', tmdbId: 550 })).length, 1);
    const diagnostic = createPlutoSourceProvider(options);
    assert.equal((await diagnostic.getSources({ contentType: 'movie', tmdbId: 550 },
      { diagnosticExactItem: true, temporaryPlutoId: 'diag001' })).length, 1);
    assert.deepEqual(itemIds, ['mapped01', 'diag001']);
    assert.equal(resolverCalls, 0);
  } finally { await close(server); }
});

test('Pluto stops mapping fallback on hard HTTP and malformed JSON failures', async () => {
  for (const [mode, expectedCode] of [
    ['forbidden', ERROR_CODES.HTTP_ERROR], ['badjson', ERROR_CODES.INVALID_JSON],
  ]) {
    const itemIds = [];
    const server = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
        sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
      }));
      itemIds.push(new URL(request.url, origin(server)).searchParams.get('ids'));
      if (mode === 'forbidden') { response.statusCode = 403; return response.end(); }
      response.end('{bad');
    });
    try {
      const provider = createPlutoSourceProvider({ id: 'pluto', enabled: true,
        baseUrl: origin(server), bootUrl: `${origin(server)}/boot`,
        http: createSafeHttpClient({ allowPrivateNetworks: true }),
        mappingResolver: { resolve: async () => [mappingRef('first01'),
          mappingRef('second1', { mappingId: 2 })] } });
      await assert.rejects(provider.getSources({ contentType: 'movie', tmdbId: 550 }),
        { code: expectedCode });
      assert.deepEqual(itemIds, ['first01']);
    } finally { await close(server); }
  }
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
  let seriesRequests = 0;
  let catalogRequests = 0;
  let searchRequests = 0;
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt,
        servers: { stitcher: origin(server) }, stitcherParams: '' }));
    }
    if (request.url.startsWith('/v2/stitch/hls/episode/episode123/master.m3u8')) {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end(hls);
    }
    if (request.url.includes('/series/')) seriesRequests += 1;
    if (request.url.includes('/categories')) catalogRequests += 1;
    if (request.url.includes('/search')) searchRequests += 1;
    itemRequests += 1;
    assert.equal(new URL(request.url, origin(server)).pathname,
      '/v2/episodes/episode123/clips.json');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ clips: [{ id: 'clip123' }] }));
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
    assert.deepEqual(await provider.getSources({ contentType: 'episode', tmdbId: 10,
      season: 2, episode: 2 }), []);
    assert.equal(itemRequests, 0);
    const candidates = await provider.getSources({ contentType: 'episode', tmdbId: 10,
      season: 1, episode: 2 });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].url, /\/v2\/stitch\/hls\/episode\/episode123\/master\.m3u8/);
    assert.equal(candidates[0].urlSensitivity, 'temporary_signed');
    assert.equal(typeof candidates[0].expiresAt, 'string');
    assert.equal(itemRequests, 1);
    assert.equal(seriesRequests, 0);
    assert.equal(catalogRequests, 0);
    assert.equal(searchRequests, 0);

    const registry = createResolverRegistry([createDirectHlsResolver({ httpClient: client })]);
    const resolved = await createResolverEngine({ registry }).resolve({
      mediaContext: { contentType: 'episode', contentId: 'episode-content-id', tmdbId: 10,
        title: 'Fixture episode', season: 1, episode: 2 },
      candidates,
    });
    assert.equal(resolved.streams.length, 1);
    assert.equal(resolved.streams[0].validated, true);
    assert.equal(resolved.streams[0].urlSensitivity, 'temporary_signed');
    assert.equal(createPrimaryAcceptanceGate().evaluate(resolved.streams[0]).code,
      'PRIMARY_ACCEPTED');
  } finally { await close(server); }
});

test('Pluto episode discovery is diagnostic-only, first-season and twenty-item bounded',
  async () => {
    const firstSeasonEpisodes = Array.from({ length: 21 }, (_, index) => ({
      _id: index === 19 ? 'episode020' : `invalid id ${index}`,
      number: index + 1,
    }));
    let seriesRequests = 0;
    const server = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) return response.end(JSON.stringify({
        sessionToken: jwt, servers: { stitcher: origin(server) }, stitcherParams: '',
      }));
      seriesRequests += 1;
      assert.match(request.url, /\/v4\/vod\/series\/series123\/seasons/);
      assert.equal(new URL(request.url, origin(server)).searchParams.get('offset'), '20');
      response.end(JSON.stringify({ seasons: [
        { number: 3, episodes: firstSeasonEpisodes },
        { number: 4, episodes: [{ _id: 'otherseason', number: 1 }] },
      ] }));
    });
    try {
      const client = createSafeHttpClient({ allowPrivateNetworks: true });
      const provider = createPlutoSourceProvider({ enabled: true, baseUrl: origin(server),
        bootUrl: `${origin(server)}/boot`, http: client, mediaMap: [] });
      const result = await provider.discoverEpisode({ seriesId: 'series123' });
      assert.deepEqual(result, { plutoId: 'episode020', season: 3,
        episode: 20, itemsChecked: 20 });
      assert.equal(seriesRequests, 1);
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
      mappingResolver: { resolve: async () => [mappingRef('movie123', { tmdbId: 1 })] },
    });
    await assert.rejects(provider.getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: 'HTTP_TIMEOUT' });

    const controller = new AbortController();
    controller.abort();
    const aborted = createPlutoSourceProvider({
      id: 'pluto_abort', enabled: true, baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`, http: client,
      mappingResolver: { resolve: async () => [mappingRef('movie123', { tmdbId: 1 })] },
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
