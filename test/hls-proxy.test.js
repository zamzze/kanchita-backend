'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://proxy:proxy@127.0.0.1:5432/proxy';
process.env.JWT_SECRET ||= 'proxy-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'proxy-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'proxy-test-tmdb-key';

const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { rewriteHlsManifest } = require('../src/modules/streams/hlsManifestRewriter');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');
const { formatResponse } = require('../src/modules/streams/streams.service');
const { createStreamLifecycle } = require('../src/modules/streams/streamLifecycle');

const streamId = crypto.randomUUID();
const secret = 'phase-s-fixture-secret-with-more-than-32-characters';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('opaque proxy token rejects tampering and expiry without exposing target URL', () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const codec = createHlsProxyTokenCodec({ secret, ttlSeconds: 60, now: () => now });
  const token = codec.issue({ streamId, targetUrl: 'https://secret.example/a.m3u8?token=x',
    kind: 'manifest' });
  assert.doesNotMatch(token, /secret|example|token|m3u8/i);
  assert.equal(codec.verify(token).streamId, streamId);
  const parts = token.split('.');
  parts[1] = `${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`;
  assert.throws(() => codec.verify(parts.join('.')), /HLS_PROXY_TOKEN_INVALID/);
  now += 61_000;
  assert.throws(() => codec.verify(token), /HLS_PROXY_TOKEN_INVALID/);
});

test('manifest rewriting covers playlists, segments, keys, maps and LL-HLS URI fields', () => {
  const manifest = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-PART:URI="part.m4s"', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'video.m3u8',
    '#EXTINF:4,', 'segment.ts'].join('\n');
  const seen = [];
  const output = rewriteHlsManifest(manifest, 'https://upstream.example/root/master.m3u8',
    (url, kind) => { seen.push({ url, kind }); return `/p/${seen.length}`; });
  assert.doesNotMatch(output, /upstream\.example|audio\.m3u8|segment\.ts/);
  assert.deepEqual(seen.map(({ kind }) => kind),
    ['manifest', 'resource', 'resource', 'resource', 'manifest', 'resource']);
});

test('proxy transports Referer/Origin, rewrites manifest and streams segment safely', async (t) => {
  const observed = [];
  const upstream = await listen((req, res) => {
    observed.push({ path: req.url, referer: req.headers.referer, origin: req.headers.origin,
      range: req.headers.range,
      cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.url === '/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Set-Cookie', 'must-not-leak=yes');
      res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts');
    } else {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Set-Cookie', 'must-not-leak=yes');
      res.end(Buffer.from('segment-fixture'));
    }
  });
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const stored = { id: streamId, stream_url: `${base}/master.m3u8`,
    playback_headers: { referer: `${base}/embed`, origin: base } };
  const proxy = createHlsProxy({ enabled: true, secret, publicBaseUrl: 'http://api.test',
    store: { findProxyStream: async () => stored },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const app = express();
  app.use('/stream-proxy', createHlsProxyRouter(proxy));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));
  const playbackUrl = proxy.createPlaybackUrl(stored);
  assert.doesNotMatch(playbackUrl, /127\.0\.0\.1|master\.m3u8/);
  const manifest = await request(app).get(new URL(playbackUrl).pathname)
    .set('Cookie', 'client=must-not-forward').set('Authorization', 'Bearer client');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers['set-cookie'], undefined);
  assert.doesNotMatch(manifest.text, /127\.0\.0\.1|segment\.ts/);
  const segmentUrl = manifest.text.split('\n').find((line) => line.startsWith('http'));
  const segment = await request(app).get(new URL(segmentUrl).pathname).set('Range', 'bytes=0-6');
  assert.equal(segment.status, 200);
  assert.equal(segment.body.toString(), 'segment-fixture');
  assert.equal(segment.headers['set-cookie'], undefined);
  assert.equal(observed.length, 2);
  assert.equal(observed[1].range, 'bytes=0-6');
  for (const item of observed) {
    assert.equal(item.referer, `${base}/embed`);
    assert.equal(item.origin, base);
    assert.equal(item.cookie, undefined);
    assert.equal(item.authorization, undefined);
  }
  const invalidRange = await request(app).get(new URL(segmentUrl).pathname)
    .set('Range', 'bytes=0-1,3-4');
  assert.equal(invalidRange.status, 416);
  assert.equal(observed.length, 2);
});

test('proxy is closed when disabled and SSRF protection remains fail-closed', async () => {
  const stored = { id: streamId, stream_url: 'http://127.0.0.1:9/master.m3u8',
    playback_headers: { referer: 'https://page.example/watch' } };
  const disabled = createHlsProxy({ enabled: false, secret,
    store: { findProxyStream: async () => stored } });
  assert.equal(disabled.available, false);
  assert.equal(disabled.createPlaybackUrl(stored), null);
  const proxy = createHlsProxy({ enabled: true, secret,
    store: { findProxyStream: async () => stored } });
  const app = express();
  app.use('/stream-proxy', createHlsProxyRouter(proxy));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));
  const result = await request(app).get(proxy.createPlaybackUrl(stored));
  assert.equal(result.status, 502);
});

test('API response hides playback headers and upstream URL behind its proxy URL', () => {
  const upstream = 'https://media.example.test/master.m3u8?token=private';
  const output = formatResponse([{ id: streamId, server_name: 'V2', quality: '1080p',
    language: 'es-419', audio_language: 'es-419', subtitle_language: null,
    stream_url: upstream, embed_url: null, stream_type: 'direct', priority: 1,
    expires_at: null, playback_headers: { referer: 'https://page.example/watch' } }],
  streamId, 'movie', null, { createPlaybackUrl: () => '/stream-proxy/opaque' });
  assert.equal(output.stream.url, '/stream-proxy/opaque');
  assert.equal(output.streams[0].stream_url, '/stream-proxy/opaque');
  assert.doesNotMatch(JSON.stringify(output), /media\.example|private|referer|page\.example/i);
});

test('lifecycle persists only the normalized playback header allowlist', async () => {
  let upsertParameters = null;
  const db = { query: async (sql, parameters) => {
    if (/^\s*SELECT/.test(sql)) return { rows: [] };
    if (/^\s*INSERT INTO streams/.test(sql)) {
      upsertParameters = parameters;
      return { rows: [{ id: streamId }] };
    }
    throw new Error('unexpected query');
  } };
  const lifecycle = createStreamLifecycle({ db, validator: async () => ({ valid: true }),
    logger: { log() {}, warn() {} }, cacheTtlMinutes: 60, verifyIntervalMinutes: 10,
    playbackTransportAvailable: true });
  await lifecycle.resolveAndPersist('movie', streamId, { tmdb_id: 1, title: 'Fixture' },
    async () => ({ url: 'https://media.example.test/master.m3u8', provider: 'v2',
      validated: true, playbackHeaders: { Referer: 'https://page.example/watch',
        Origin: 'https://page.example' } }));
  assert.deepEqual(upsertParameters[21], {
    referer: 'https://page.example/watch', origin: 'https://page.example',
  });
});
