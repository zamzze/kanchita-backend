'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://trusted:trusted@127.0.0.1:5432/trusted';
process.env.JWT_SECRET ||= 'trusted-transport-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'trusted-transport-refresh-secret';
process.env.TMDB_API_KEY ||= 'trusted-transport-tmdb-key';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createSafeHttpClient } =
  require('../src/modules/streams/http/safeHttpClient');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { createStreamsController } = require('../src/modules/streams/streams.controller');
const { formatResponse } = require('../src/modules/streams/streams.service');
const { createTrustedPlaybackModeForStream, loadTrustedPlaybackModeForStream } =
  require('../src/modules/streams/trustedPlaybackTransport');

const referer = 'https://page.example.test/watch';
const secret = 'trusted-playback-transport-local-test-secret';
const entry = (id, options = {}) => ({
  id, type: 'persisted_sources', enabled: true, region: 'global', ...options,
});
const loaded = (sources) => loadResolverV2Catalog({ enabled: true,
  filePath: 'trusted-fixture.json',
  readFile: () => JSON.stringify({ version: 1, sources }) });

test('only enabled persisted-provider catalog entries select playlist-only', () => {
  const catalog = loaded([
    entry('full_fixture'), entry('playlist_only_fixture',
      { hlsProxyMode: 'playlists-only' }),
    entry('disabled_fixture', { enabled: false, hlsProxyMode: 'playlists-only' }),
  ]);
  assert.equal(catalog.sources.find((source) => source.id === 'full_fixture').hlsProxyMode,
    'full');
  const modeFor = createTrustedPlaybackModeForStream(catalog);
  assert.equal(modeFor({ stream_type: 'direct', provider: 'full_fixture' }), 'full');
  assert.equal(modeFor({ stream_type: 'direct', provider: 'playlist_only_fixture' }),
    'playlists-only');
  assert.equal(modeFor({ stream_type: 'direct', provider: 'disabled_fixture' }), 'full');
  assert.equal(modeFor({ stream_type: 'direct', provider: 'unknown' }), 'full');
  assert.equal(modeFor({ stream_type: 'mp4', provider: 'playlist_only_fixture' }), 'full');
  assert.equal(modeFor({ stream_type: 'direct', provider: 'full_fixture',
    playbackMode: 'playlists-only', metadata: { hlsProxyMode: 'playlists-only' } }), 'full');
  assert.equal(createTrustedPlaybackModeForStream({ loaded: false })(null), 'full');
  assert.equal(createTrustedPlaybackModeForStream(catalog,
    { reservedProviderIds: ['PLAYLIST_ONLY_FIXTURE'] })(
    { stream_type: 'direct', provider: 'playlist_only_fixture' }), 'full');
});

test('invalid catalog mode is rejected; loader failure and invalid callback fail closed', () => {
  const invalid = loaded([entry('invalid_fixture', { hlsProxyMode: 'stream-everything' })]);
  assert.equal(invalid.sources.length, 0);
  assert.equal(createTrustedPlaybackModeForStream(invalid)(
    { stream_type: 'direct', provider: 'invalid_fixture' }), 'full');
  const modeFor = loadTrustedPlaybackModeForStream({
    enabled: true, filePath: 'missing.json',
    catalogLoader: () => ({ loaded: false, sources: [] }),
  });
  assert.equal(modeFor({ stream_type: 'direct', provider: 'playlist_only_fixture' }), 'full');
  const loadedMode = loadTrustedPlaybackModeForStream({
    enabled: true, filePath: 'trusted-fixture.json',
    catalogLoader: () => loaded([entry('playlist_only_fixture',
      { hlsProxyMode: 'playlists-only' })]),
    reservedProviderIds: [],
  });
  assert.equal(loadedMode({ stream_type: 'direct', provider: 'playlist_only_fixture' }),
    'playlists-only');
  const stream = { id: crypto.randomUUID(), stream_url: 'https://media.example.test/a.m3u8',
    stream_type: 'direct', playback_headers: { referer }, provider: 'full_fixture' };
  const issued = [];
  const proxy = { createPlaybackUrl: (_stored, options) => {
    issued.push(options.mode); return '/stream-proxy/opaque';
  } };
  formatResponse([stream], 'movie-1', 'movie', null, proxy, () => 'invalid');
  formatResponse([stream], 'movie-1', 'movie', null, proxy, () => {
    throw new Error('broken server configuration');
  });
  assert.deepEqual(issued, ['full', 'full']);
});

test('local persisted HLS sources use one direct resolver but provider-owned signed modes',
  async (t) => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ path: req.url, referer: req.headers.referer });
      if (req.url === '/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8');
      }
      if (req.url === '/child.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end([
          '#EXTM3U',
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="es",URI="subs.m3u8"',
          '#EXT-X-PART:DURATION=0.5,URI="part.ts"',
          '#EXTINF:4,',
          'segment.ts',
          '#EXTINF:4,',
          'https://other.example.test/cross.ts',
          '#EXTINF:4,',
          'video.m4s',
          '#EXTINF:4,',
          'unknown.bin',
        ].join('\n'));
      }
      res.writeHead(404); return res.end();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const catalogEntries = [entry('full_fixture'), entry('playlist_only_fixture',
      { hlsProxyMode: 'playlists-only' })];
    const catalog = loaded(catalogEntries);
    const mappingIds = { full_fixture: 1, playlist_only_fixture: 2 };
    const runtime = createShadowPipeline({
      catalogEnabled: true, catalogPath: 'trusted-fixture.json',
      catalogReadFile: () => JSON.stringify({ version: 1, sources: catalogEntries }),
      providerMappingResolver: { resolve: async ({ providerId }) => [{
        mappingId: mappingIds[providerId], providerId, region: 'global',
        contentType: 'movie', tmdbId: 550, seasonNumber: null, episodeNumber: null,
      }] },
      providerSourceStore: { findActiveSourcesForMapping: async (mappingId) => [{
        id: crypto.randomUUID(), mapping_id: mappingId, status: 'active',
        source_type: 'direct_hls', source_url: `${base}/master.m3u8`,
        headers_json: { referer }, metadata: {},
      }] },
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
      healthEnabled: false, primaryEnabled: true, playbackTransportAvailable: true,
    });
    const resolved = await runtime.pipeline.resolve({
      contentType: 'movie', contentId: 'movie-1', tmdbId: 550, title: 'Fixture',
    });
    assert.equal(resolved.streams.length, 2);
    assert.deepEqual(new Set(resolved.streams.map((stream) => stream.resolverId)),
      new Set(['direct_hls']));
    assert.ok(resolved.streams.every((stream) =>
      stream.validated && stream.headers.referer === referer));
    const byProvider = new Map(resolved.streams.map((stream) => [stream.providerId, stream]));
    const stored = new Map();
    for (const providerId of Object.keys(mappingIds)) {
      const candidate = byProvider.get(providerId);
      assert.ok(candidate);
      const row = { id: crypto.randomUUID(), provider: providerId,
        stream_url: candidate.url, stream_type: 'direct',
        playback_headers: candidate.headers, server_name: 'fixture', quality: 'auto',
        language: 'es-419', priority: 1 };
      stored.set(row.id, row);
    }
    const codec = createHlsProxyTokenCodec({ secret });
    const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
      store: { findProxyStream: async (id) => stored.get(id) || null },
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
    const app = express();
    app.use('/stream-proxy', createHlsProxyRouter(proxy));
    app.use((error, _req, res, _next) =>
      res.status(error.statusCode || 500).json({ code: error.code }));
    const modeFor = createTrustedPlaybackModeForStream(catalog);
    for (const providerId of Object.keys(mappingIds)) {
      const row = [...stored.values()].find((item) => item.provider === providerId);
      const response = formatResponse([row], 'movie-1', 'movie', null, proxy, modeFor);
      const tokenPath = response.stream.url;
      const expectedMode = providerId === 'playlist_only_fixture' ? 'playlists-only' : 'full';
      assert.equal(codec.verify(tokenPath.split('/').at(-1)).mode, expectedMode);
      assert.doesNotMatch(JSON.stringify(response), /page\.example\.test|master\.m3u8/);
      const master = await request(app).get(
        `${tokenPath}?proxyMode=playlists-only`).set('Referer', 'https://attacker.example.test/');
      assert.equal(master.status, 200);
      const childPath = master.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
      assert.ok(childPath);
      assert.equal(codec.verify(childPath.split('/').at(-1)).mode, expectedMode);
      const child = await request(app).get(childPath);
      assert.equal(child.status, 200);
      assert.match(child.text, /\/stream-proxy\//);
      for (const tag of ['EXT-X-KEY', 'EXT-X-MAP', 'EXT-X-MEDIA', 'EXT-X-PART']) {
        assert.match(child.text, new RegExp(`#${tag}:.*URI="/stream-proxy/`));
      }
      const mediaLines = child.text.split('\n').filter((line) =>
        line && !line.startsWith('#'));
      assert.equal(mediaLines.length, 4);
      if (expectedMode === 'playlists-only') {
        assert.equal(mediaLines[0], `${base}/segment.ts`);
        assert.ok(mediaLines.slice(1).every((line) => line.startsWith('/stream-proxy/')));
      } else {
        assert.ok(mediaLines.every((line) => line.startsWith('/stream-proxy/')));
      }
      assert.match(child.text, /URI="\/stream-proxy\//);
      assert.doesNotMatch(child.text, /\nhttps:\/\/other\.example\.test/);
      const tampered = `${tokenPath.slice(0, -1)}${tokenPath.at(-1) === 'a' ? 'b' : 'a'}`;
      assert.equal((await request(app).get(tampered)).status, 404);
    }
    assert.ok(seen.every((item) => item.referer === referer));
    assert.equal(seen.filter((item) => item.path === '/master.m3u8').length, 4);
    assert.equal(seen.filter((item) => item.path === '/child.m3u8').length, 2);
  });

test('HTTP controller forwards only route identity and user, never client mode', async () => {
  const calls = [];
  const controller = createStreamsController({
    getMovieStreams: async (...args) => {
      calls.push(args); return { status: 'ready', streams: [] };
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: 'user-1' }; next(); });
  app.get('/movie/:id', controller.getMovieStreams);
  const response = await request(app).get('/movie/movie-1?proxyMode=playlists-only')
    .set('X-Playback-Mode', 'playlists-only')
    .send({ playbackMode: 'playlists-only' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['movie-1', 'user-1']]);
});
