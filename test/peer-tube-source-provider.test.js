'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://test.invalid/test';
process.env.JWT_SECRET ||= 'unused-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'unused-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'unused-test-tmdb-key';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createPeerTubeSourceProvider, normalizeMediaMap } =
  require('../src/modules/streams/resolverV2/providers/peerTubeSourceProvider');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPreflightRunner } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const hls = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8\n';

test('PeerTube media map is bounded, explicit and first-valid-wins', () => {
  const map = normalizeMediaMap([
    { contentType: 'movie', tmdbId: 1, videoId: 'abcdef' },
    { contentType: 'movie', tmdbId: 1, videoId: 'ignored2' },
    { contentType: 'episode', tmdbId: 2, season: 0, episode: 1,
      videoId: '12345678-1234-1234-1234-123456789abc' },
  ]);
  assert.equal(map.length, 2);
  assert.equal(map[0].videoId, 'abcdef');
  assert.equal(normalizeMediaMap([
    { contentType: 'movie', tmdbId: 1, videoId: 42 },
  ])[0].videoId, '42');
  assert.equal(normalizeMediaMap([
    { contentType: 'movie', tmdbId: 0, videoId: 'badbad' },
  ]), null);
  assert.equal(normalizeMediaMap([
    { contentType: 'movie', tmdbId: 1, videoId: 'abcdef', url: 'https://unsafe' },
  ]), null);
  assert.equal(normalizeMediaMap(Array.from({ length: 257 }, () => ({}))), null);
});

test('PeerTube source reads official video detail shape and emits minimal HLS candidates', async () => {
  let requestPath; let accept;
  const server = await listen((request, response) => {
    requestPath = request.url; accept = request.headers.accept;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      title: 'PRIVATE TITLE', account: { name: 'PRIVATE CREATOR' },
      streamingPlaylists: [
        { playlistUrl: `${origin(server)}/master.m3u8`, files: [] },
        { playlistUrl: `${origin(server)}/second.m3u8` },
      ],
    }));
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const provider = createPeerTubeSourceProvider({
      id: 'peer_a', enabled: true, baseUrl: origin(server), http: client,
      maxCandidates: 1,
      mediaMap: [{ contentType: 'movie', tmdbId: 550, videoId: 'AbCdEf12' }],
    });
    assert.equal(provider.descriptor.strategy, 'http');
    assert.equal((await provider.getSources({ contentType: 'movie', tmdbId: 999 },
      { http: client })).length, 0);
    const candidates = await provider.getSources({ contentType: 'movie', tmdbId: 550 },
      { http: client });
    assert.equal(requestPath, '/api/v1/videos/AbCdEf12');
    assert.equal(accept, 'application/json');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'peer_a');
    assert.deepEqual(candidates[0].headers, {});
    assert.deepEqual(candidates[0].metadata, { sourceType: 'peertube' });
    assert.doesNotMatch(JSON.stringify(candidates), /PRIVATE TITLE|PRIVATE CREATOR/);
  } finally { await close(server); }
});

test('PeerTube status and malformed response semantics fail closed', async () => {
  const server = await listen((request, response) => {
    const id = request.url.split('/').pop();
    if (id === 'notfound') { response.statusCode = 404; return response.end(); }
    if (id === 'forbidden') { response.statusCode = 403; return response.end(); }
    response.setHeader('content-type', 'application/json');
    response.end(id === 'nohlss' ? JSON.stringify({ streamingPlaylists: [] }) : '{bad');
  });
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const make = (videoId) => createPeerTubeSourceProvider({
    id: `p_${videoId}`, enabled: true, baseUrl: origin(server), http: client,
    mediaMap: [{ contentType: 'movie', tmdbId: 1, videoId }],
  });
  try {
    assert.deepEqual(await make('notfound').getSources({ contentType: 'movie', tmdbId: 1 }), []);
    assert.deepEqual(await make('nohlss').getSources({ contentType: 'movie', tmdbId: 1 }), []);
    await assert.rejects(make('forbidden').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: 'SOURCE_PEERTUBE_HTTP_ERROR' });
    await assert.rejects(make('badjson').getSources({ contentType: 'movie', tmdbId: 1 }),
      { code: 'SOURCE_PEERTUBE_INVALID_JSON' });
  } finally { await close(server); }
});

test('catalog accepts only strict PeerTube entries and composes preflight/primary end to end', async () => {
  const server = await listen((request, response) => {
    if (request.url.startsWith('/api/v1/videos/')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ streamingPlaylists: [
        { playlistUrl: `${origin(server)}/master.m3u8` },
      ] }));
    }
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end(hls);
  });
  const entry = { id: 'peer_catalog', type: 'peertube', enabled: true,
    baseUrl: origin(server), priority: 100, timeoutMs: 2000, maxCandidates: 2,
    mediaMap: [{ contentType: 'movie', tmdbId: 550, videoId: 'abcdef' }] };
  try {
    const normalized = normalizeCatalog({ version: 1, sources: [entry], resolvers: [] });
    assert.equal(normalized.sources[0].type, 'peertube');
    for (const forbidden of ['headers', 'authTokenEnv', 'browser', 'script']) {
      assert.equal(normalizeCatalog({ version: 1,
        sources: [{ ...entry, [forbidden]: {} }], resolvers: [] }).sources.length, 0);
    }
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const runtime = createShadowPipeline({
      httpClient: client, catalogEnabled: true, catalogPath: 'fixture.json',
      catalogReadFile: () => Buffer.from(JSON.stringify({
        version: 1, sources: [entry], resolvers: [],
      })), enabled: false, primaryEnabled: true, timeoutMs: 3000,
      primaryTimeoutMs: 3000,
    });
    const result = await createPreflightRunner({ runtime, catalogEnabled: true })
      .run({ contentType: 'movie', tmdbId: 550 }, { timeoutMs: 3000 });
    assert.equal(result.status, 'ready');
    assert.equal(result.acceptanceSummary.accepted, true);
    assert.doesNotMatch(JSON.stringify(result), /abcdef|127\.0\.0\.1|peer_catalog/);
    const primary = await runtime.primaryResolver.resolve({
      contentType: 'movie', contentId: 'fixture', tmdbId: 550, title: 'fixture',
    });
    assert.equal(primary.status, 'accepted');
  } finally { await close(server); }
});

test('PeerTube provider has no browser, legacy or direct transport coupling', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/providers/peerTubeSourceProvider'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|browserSlots|ProviderC|ResolverExecutor|child_process|linkExtractor|\bfetch\s*\(|http\.get|https\.get|axios/i);
});
