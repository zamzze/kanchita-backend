'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://proxy:proxy@127.0.0.1:5432/proxy';
process.env.JWT_SECRET ||= 'proxy-readiness-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'proxy-readiness-refresh-secret';
process.env.TMDB_API_KEY ||= 'proxy-readiness-tmdb-key';

const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { rewriteHlsManifest } = require('../src/modules/streams/hlsManifestRewriter');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');

const secret = 'phase-t-proxy-secret-with-at-least-32-characters';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});
const errorMiddleware = (error, _req, res, _next) =>
  res.status(error.statusCode || 500).json({ code: error.code || 'INTERNAL_ERROR' });
const proxyApp = (proxy) => {
  const app = express();
  app.use('/stream-proxy', createHlsProxyRouter(proxy));
  app.use(errorMiddleware);
  return app;
};
const tokenFromUrl = (value) => new URL(value, 'http://api.test').pathname.split('/').at(-1);

test('proxy token is opaque, replayable only before expiry, and fails closed for tampering', () => {
  let now = Date.parse('2035-01-01T00:00:00Z');
  const streamId = crypto.randomUUID();
  const codec = createHlsProxyTokenCodec({ secret, ttlSeconds: 30, now: () => now });
  const targetUrl = 'https://media.example.test/master.m3u8?signature=private';
  const token = codec.issue({ streamId, targetUrl, kind: 'manifest' });
  assert.doesNotMatch(token, /media|example|master|signature|private/i);
  assert.deepEqual(codec.verify(token), codec.verify(token));
  assert.equal(codec.verify(token).targetUrl, targetUrl);

  const parts = token.split('.');
  for (const index of [1, 3]) {
    const changed = [...parts];
    changed[index] = `${changed[index][0] === 'A' ? 'B' : 'A'}${changed[index].slice(1)}`;
    assert.throws(() => codec.verify(changed.join('.')), (error) =>
      error.code === 'HLS_PROXY_TOKEN_INVALID' && !/media|signature|private/i.test(error.message));
  }
  const otherCodec = createHlsProxyTokenCodec({ secret: `${secret}-different` });
  for (const malformed of ['', 'a.b.c', `${token}.extra`, '%not-a-token']) {
    assert.throws(() => codec.verify(malformed), { code: 'HLS_PROXY_TOKEN_INVALID' });
  }
  assert.throws(() => otherCodec.verify(token), { code: 'HLS_PROXY_TOKEN_INVALID' });
  assert.throws(() => codec.issue({ streamId: '------------------------------------', targetUrl }),
    { code: 'HLS_PROXY_TOKEN_INVALID' });
  now += 31_000;
  assert.throws(() => codec.verify(token), { code: 'HLS_PROXY_TOKEN_INVALID' });
});

test('manifest rewrite covers master, media and low-latency URI-bearing tags without leaks', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/list.m3u8?lang=es"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8#main"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/key?id=1"',
    '#EXT-X-MAP:URI="init.mp4?x=1"',
    '#EXT-X-PART:DURATION=0.5,URI="part-1.m4s?x=1"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"',
    '#EXT-X-RENDITION-REPORT:URI="../other.m3u8?x=1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2',
    'video/variant.m3u8?token=hidden',
    '#EXTINF:4,',
    'segment.ts?token=hidden',
  ].join('\n');
  const seen = [];
  const output = rewriteHlsManifest(manifest,
    'https://origin.example.test/path/master.m3u8?root=hidden', (url, kind) => {
      seen.push({ url, kind });
      return `/stream-proxy/opaque-${seen.length}`;
    });
  assert.equal(seen.length, 9);
  assert.deepEqual(seen.map(({ kind }) => kind), [
    'manifest', 'manifest', 'resource', 'resource', 'resource', 'resource',
    'manifest', 'manifest', 'resource',
  ]);
  assert.doesNotMatch(output, /origin\.example|keys\.example|hidden|\.m3u8|\.m4s|\.ts/i);
  assert.match(output, /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="\/stream-proxy\/opaque-6"/);
});

test('full proxy chain rewrites master and media playlists and isolates playback headers', async (t) => {
  const observed = [];
  const upstream = await listen((req, res) => {
    observed.push({ path: req.url, referer: req.headers.referer, origin: req.headers.origin,
      cookie: req.headers.cookie, authorization: req.headers.authorization,
      proxyAuthorization: req.headers['proxy-authorization'] });
    if (req.headers.referer !== 'https://page.example.test/embed' ||
        req.headers.origin !== 'https://page.example.test') {
      res.writeHead(403); return res.end('denied');
    }
    res.setHeader('Set-Cookie', 'upstream=must-not-leak');
    res.setHeader('X-Upstream-Secret', 'must-not-leak');
    if (req.url.startsWith('/master.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8?sig=private');
    }
    if (req.url.startsWith('/variant.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts?sig=private');
    }
    res.setHeader('Content-Type', 'video/mp2t');
    return res.end('segment-payload');
  });
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const stored = { id: crypto.randomUUID(), stream_url: `${base}/master.m3u8?sig=root`,
    playback_headers: { referer: 'https://page.example.test/embed',
      origin: 'https://page.example.test' } };
  const proxy = createHlsProxy({ enabled: true, secret,
    store: { findProxyStream: async (id) => id === stored.id ? stored : null },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const app = proxyApp(proxy);
  const clientHeaders = { Cookie: 'client=private', Authorization: 'Bearer private',
    'Proxy-Authorization': 'Basic private' };
  const master = await request(app).get(proxy.createPlaybackUrl(stored)).set(clientHeaders);
  assert.equal(master.status, 200);
  assert.equal(master.headers['set-cookie'], undefined);
  assert.equal(master.headers['x-upstream-secret'], undefined);
  assert.doesNotMatch(master.text, /127\.0\.0\.1|sig=|variant\.m3u8/i);
  const variantPath = master.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
  const variant = await request(app).get(variantPath).set(clientHeaders);
  assert.equal(variant.status, 200);
  assert.doesNotMatch(variant.text, /127\.0\.0\.1|sig=|segment\.ts/i);
  const segmentPath = variant.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
  const segment = await request(app).get(segmentPath).set(clientHeaders);
  assert.equal(segment.status, 200);
  assert.equal(segment.body.toString(), 'segment-payload');
  assert.equal(segment.headers['set-cookie'], undefined);
  assert.equal(segment.headers['x-upstream-secret'], undefined);
  assert.equal(observed.length, 3);
  for (const item of observed) {
    assert.equal(item.referer, stored.playback_headers.referer);
    assert.equal(item.origin, stored.playback_headers.origin);
    assert.equal(item.cookie, undefined);
    assert.equal(item.authorization, undefined);
    assert.equal(item.proxyAuthorization, undefined);
  }
});

test('range forwarding accepts one byte range and rejects multiple ranges before upstream', async () => {
  const ranges = [];
  const upstream = await listen((req, res) => {
    ranges.push(req.headers.range);
    res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-3/8',
      'Accept-Ranges': 'bytes' });
    res.end('data');
  });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const stored = { id: crypto.randomUUID(), stream_url: `${base}/master.m3u8`,
    playback_headers: { referer: 'https://page.example.test/embed' } };
  const codec = createHlsProxyTokenCodec({ secret });
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const app = proxyApp(proxy);
  const resource = `/stream-proxy/${codec.issue({ streamId: stored.id,
    targetUrl: `${base}/segment.ts`, kind: 'resource' })}`;
  const valid = await request(app).get(resource).set('Range', 'bytes=0-3');
  assert.equal(valid.status, 206);
  assert.equal(valid.headers['content-range'], 'bytes 0-3/8');
  const invalid = await request(app).get(resource).set('Range', 'bytes=0-1,4-5');
  assert.equal(invalid.status, 416);
  assert.deepEqual(ranges, ['bytes=0-3']);
  await close(upstream);
});

test('large segment uses stream backpressure instead of whole-body buffering', async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const chunkCount = 96;
  let backpressureCount = 0;
  const upstream = await listen(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    for (let index = 0; index < chunkCount; index += 1) {
      if (!res.write(chunk)) {
        backpressureCount += 1;
        await once(res, 'drain');
      }
    }
    res.end();
  });
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const stored = { id: crypto.randomUUID(), stream_url: `${base}/master.m3u8`,
    playback_headers: { referer: 'https://page.example.test/embed' } };
  const codec = createHlsProxyTokenCodec({ secret });
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const server = await listen(proxyApp(proxy));
  t.after(() => close(server));
  const token = codec.issue({ streamId: stored.id, targetUrl: `${base}/large.ts`, kind: 'resource' });
  const bytes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/stream-proxy/${token}`, (res) => {
      let total = 0;
      let paused = false;
      res.on('data', (data) => {
        total += data.length;
        if (!paused) {
          paused = true;
          res.pause();
          setTimeout(() => res.resume(), 40);
        }
      });
      res.once('end', () => resolve(total));
      res.once('error', reject);
    }).once('error', reject);
  });
  assert.equal(bytes, chunk.length * chunkCount);
  assert.ok(backpressureCount > 0);
});

test('downstream disconnect aborts an in-flight upstream request before response headers', async (t) => {
  let upstreamAborted = false;
  const streamClient = {
    get: async () => { throw new Error('unexpected manifest request'); },
    stream: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        upstreamAborted = true;
        reject(Object.assign(new Error('aborted'), { code: 'HTTP_ABORTED' }));
      }, { once: true });
    }),
  };
  const stored = { id: crypto.randomUUID(), stream_url: 'https://media.example.test/master.m3u8',
    playback_headers: { referer: 'https://page.example.test/embed' } };
  const codec = createHlsProxyTokenCodec({ secret });
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored }, httpClient: streamClient });
  const server = await listen(proxyApp(proxy));
  t.after(() => close(server));
  const token = codec.issue({ streamId: stored.id,
    targetUrl: 'https://media.example.test/slow.ts', kind: 'resource' });
  const clientRequest = http.get(
    `http://127.0.0.1:${server.address().port}/stream-proxy/${token}`
  );
  clientRequest.once('error', () => {});
  await new Promise((resolve) => setTimeout(resolve, 15));
  clientRequest.destroy();
  const deadline = Date.now() + 500;
  while (!upstreamAborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(upstreamAborted, true);
});

test('concurrent proxy requests keep per-stream playback headers isolated', async (t) => {
  const mismatches = [];
  const upstream = await listen((req, res) => {
    const id = new URL(req.url, 'http://fixture').searchParams.get('id');
    if (req.headers.referer !== `https://page.example.test/embed/${id}` ||
        req.headers.origin !== `https://origin-${id}.example.test`) mismatches.push(id);
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(`segment-${id}`);
  });
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const rows = new Map();
  const codec = createHlsProxyTokenCodec({ secret });
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async (id) => rows.get(id) || null },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const app = proxyApp(proxy);
  const paths = Array.from({ length: 20 }, (_, index) => {
    const id = crypto.randomUUID();
    rows.set(id, { id, stream_url: `${base}/master.m3u8`, playback_headers: {
      referer: `https://page.example.test/embed/${index}`,
      origin: `https://origin-${index}.example.test`,
    } });
    return `/stream-proxy/${codec.issue({ streamId: id,
      targetUrl: `${base}/segment.ts?id=${index}`, kind: 'resource' })}`;
  });
  const responses = await Promise.all(paths.map((path) => request(app).get(path)
    .set('Cookie', 'client=private').set('Authorization', 'Bearer private')));
  assert.equal(responses.every(({ status }) => status === 200), true);
  assert.deepEqual(mismatches, []);
});

test('client-controlled URL query cannot substitute the token-bound upstream resource', async () => {
  const targets = [];
  const stored = { id: crypto.randomUUID(), stream_url: 'https://media.example.test/master.m3u8',
    playback_headers: { referer: 'https://page.example.test/embed' } };
  const codec = createHlsProxyTokenCodec({ secret });
  const httpClient = { get: async () => { throw new Error('unexpected'); },
    stream: async (url) => {
      targets.push(url);
      const { Readable } = require('node:stream');
      return { ok: true, status: 200, headers: { 'content-type': 'video/mp2t' },
        body: Readable.from(['data']), abort() {} };
    } };
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored }, httpClient });
  const target = 'https://media.example.test/segment.ts?id=trusted';
  const token = codec.issue({ streamId: stored.id, targetUrl: target, kind: 'resource' });
  const response = await request(proxyApp(proxy))
    .get(`/stream-proxy/${token}?url=https://attacker.example/private&id=substitute`);
  assert.equal(response.status, 200);
  assert.deepEqual(targets, [target]);
  assert.equal(tokenFromUrl(`/stream-proxy/${token}`), token);
});
