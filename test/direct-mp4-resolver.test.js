'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, test } = require('node:test');
process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://streams:streams@127.0.0.1:5432/streams';
process.env.JWT_SECRET ||= 'streams-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'streams-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'streams-test-tmdb-key';
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createDirectMp4Resolver } =
  require('../src/modules/streams/resolverV2/resolvers/directMp4Resolver');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { createStreamRanker } =
  require('../src/modules/streams/resolverV2/ranking/streamRanker');
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { createStreamLifecycle } = require('../src/modules/streams/streamLifecycle');
const { formatResponse } = require('../src/modules/streams/streams.service');

const mp4Body = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'),
  Buffer.alloc(52)]);
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n';
let server;
let baseUrl;
const counts = new Map();

before(async () => {
  server = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.local').pathname;
    counts.set(`${request.method} ${path}`, (counts.get(`${request.method} ${path}`) || 0) + 1);
    if (path === '/redirect.mp4') {
      response.writeHead(302, { location: '/valid.mp4' });
      return response.end();
    }
    if (path === '/unsafe.mp4') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      return response.end();
    }
    if (path === '/missing.mp4') {
      response.writeHead(404);
      return response.end();
    }
    if (path === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return response.end(playlist);
    }
    if (path === '/head-405.mp4' && request.method === 'HEAD') {
      response.writeHead(405);
      return response.end();
    }
    if (path === '/head-403.mp4' && request.method === 'HEAD') {
      response.writeHead(403);
      return response.end();
    }
    const contentType = path === '/html.mp4' ? 'text/html'
      : path === '/octet.mp4' ? 'application/octet-stream' : 'video/mp4';
    response.setHeader('content-type', contentType);
    if (request.method === 'HEAD') return response.end();
    if (path === '/large.mp4') {
      response.setHeader('content-length', 1024);
      return response.end(Buffer.alloc(1024));
    }
    assert.equal(request.headers.range, 'bytes=0-63');
    response.statusCode = 206;
    return response.end(path === '/bad-body.mp4' || path === '/html.mp4'
      ? Buffer.from('<html>not video</html>') : mp4Body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const candidate = (path, extra = {}) => ({ providerId: 'fixture', url: `${baseUrl}${path}`,
  ...extra });
const resolver = () => createDirectMp4Resolver({
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 500 }),
  timeoutMs: 450,
});

test('MP4 validation uses HEAD and a 64-byte Range GET, preserving metadata', async () => {
  const result = await resolver().resolve(candidate('/valid.mp4', {
    qualityHint: '1080p', languageHint: 'es-419',
  }));
  assert.equal(result.length, 1);
  assert.equal(result[0].protocol, 'mp4');
  assert.equal(result[0].resolverId, 'direct_mp4');
  assert.equal(result[0].providerId, 'fixture');
  assert.equal(result[0].validated, true);
  assert.equal(result[0].quality, '1080p');
  assert.equal(result[0].audioLanguage, 'es-419');
  assert.ok(result[0].latencyMs >= 0);
  assert.equal(counts.get('HEAD /valid.mp4'), 1);
  assert.equal(counts.get('GET /valid.mp4'), 1);
});

test('HTML or incorrect body is rejected, as are ordinary HTTP errors', async () => {
  assert.deepEqual(await resolver().resolve(candidate('/html.mp4')), []);
  assert.equal(counts.get('GET /html.mp4') || 0, 0);
  assert.deepEqual(await resolver().resolve(candidate('/bad-body.mp4')), []);
  assert.deepEqual(await resolver().resolve(candidate('/missing.mp4')), []);
});

test('safe redirects and HEAD failures use bounded GET fallback', async () => {
  const redirected = await resolver().resolve(candidate('/redirect.mp4'));
  assert.equal(redirected[0].url, `${baseUrl}/valid.mp4`);
  assert.equal((await resolver().resolve(candidate('/head-405.mp4'))).length, 1);
  assert.equal((await resolver().resolve(candidate('/head-403.mp4'))).length, 1);
  assert.equal((await resolver().resolve(candidate('/octet.mp4'))).length, 1);
});

test('private addresses and redirects remain blocked by default SafeHttpClient policy', async () => {
  const secure = createDirectMp4Resolver({ httpClient: createSafeHttpClient(), timeoutMs: 450 });
  await assert.rejects(secure.resolve(candidate('/valid.mp4')),
    (error) => error.code === 'HTTP_UNSAFE_DESTINATION');
  const redirectClient = createSafeHttpClient({
    dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: (url, options, callback) => http.request({
      hostname: '127.0.0.1', port: server.address().port, path: url.pathname,
      method: options.method, headers: options.headers, agent: false,
    }, callback),
  });
  await assert.rejects(createDirectMp4Resolver({ httpClient: redirectClient })
    .resolve({ providerId: 'fixture', url: 'http://public.example.test/unsafe.mp4' }),
  (error) => error.code === 'HTTP_UNSAFE_DESTINATION');
});

test('oversized response is aborted; no full video download', async () => {
  await assert.rejects(resolver().resolve(candidate('/large.mp4')),
    (error) => error.code === 'HTTP_RESPONSE_TOO_LARGE');
});

test('HLS and MP4 coexist and deterministic ranking keeps HLS preference', async () => {
  const client = createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 500 });
  const registry = createResolverRegistry([
    createDirectHlsResolver({ httpClient: client, timeoutMs: 450 }),
    createDirectMp4Resolver({ httpClient: client, timeoutMs: 450 }),
  ]);
  const engine = createResolverEngine({ registry, timeoutMs: 1000 });
  const result = await engine.resolve({
    mediaContext: { contentType: 'movie', contentId: 'fixture', tmdbId: 550,
      title: 'Local Fixture' },
    candidates: [candidate('/valid.mp4'), candidate('/master.m3u8')],
  });
  assert.deepEqual(result.streams.map((stream) => stream.protocol), ['mp4', 'hls']);
  const ranked = createStreamRanker().rank(result.streams);
  assert.deepEqual(ranked.map((stream) => stream.protocol), ['hls', 'mp4']);
  assert.equal(createPrimaryAcceptanceGate().evaluate(ranked[1]).accepted, true);
});

test('MP4 lifecycle persists a distinct stream type and cache/API return direct playback', async () => {
  let row = null;
  let storedType = null;
  let mp4ValidationCalls = 0;
  let hlsValidationCalls = 0;
  const db = { query: async (sql, params) => {
    if (sql.includes('SELECT') && sql.includes('FROM streams')) {
      assert.match(sql, /stream_type IN \('direct', 'mp4'\)/);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('INSERT INTO streams')) {
      storedType = params[7];
      row = { id: 'stream-1', stream_url: params[5], stream_type: params[7],
        status: 'ready', expires_at: params[11], last_verified_at: params[13],
        url_sensitivity: 'normal', playback_headers: null, priority: 1 };
      return { rows: [row] };
    }
    if (sql.includes('SET status =') && sql.includes('last_verified_at = NOW()')) {
      row = { ...row, last_verified_at: new Date() };
      return { rows: [row] };
    }
    throw new Error('Unexpected database query');
  } };
  const lifecycle = createStreamLifecycle({ db, cacheTtlMinutes: 60,
    verifyIntervalMinutes: 10, logger: { log() {}, warn() {} },
    validator: async () => { hlsValidationCalls += 1; return { valid: true }; },
    mp4Validator: async () => { mp4ValidationCalls += 1; return { valid: true }; },
  });
  await lifecycle.resolveAndPersist('movie', 'movie-1', { tmdb_id: 550, title: 'Fixture' },
    async () => ({ url: `${baseUrl}/valid.mp4`, streamType: 'mp4', validated: true,
      provider: 'fixture' }));
  assert.equal(storedType, 'mp4');
  let cached = await lifecycle.readUsableCache('movie', 'movie-1', { validate: true });
  assert.equal(cached.streams[0].stream_url, `${baseUrl}/valid.mp4`);
  assert.equal(mp4ValidationCalls, 0);
  row.last_verified_at = new Date(Date.now() - 30 * 60 * 1000);
  cached = await lifecycle.readUsableCache('movie', 'movie-1', { validate: true });
  assert.equal(cached.streams.length, 1);
  assert.equal(mp4ValidationCalls, 1);
  assert.equal(hlsValidationCalls, 0);
  const api = formatResponse(cached.streams, 'movie-1', 'movie');
  assert.equal(api.stream.type, 'mp4');
  assert.equal(api.stream.url, `${baseUrl}/valid.mp4`);
  assert.equal(api.streams[0].stream_type, 'mp4');
  const headerBound = formatResponse([{ ...cached.streams[0],
    playback_headers: { referer: 'https://player.example.test/' } }],
  'movie-1', 'movie', null, { createPlaybackUrl: () => 'https://proxy.example.test/' });
  assert.equal(headerBound.stream.url, null);
});
