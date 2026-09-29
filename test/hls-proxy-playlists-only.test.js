'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://proxy:proxy@127.0.0.1:5432/proxy';
process.env.JWT_SECRET ||= 'playlist-proxy-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'playlist-proxy-refresh-secret';
process.env.TMDB_API_KEY ||= 'playlist-proxy-tmdb-key';

const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { rewriteHlsManifest } = require('../src/modules/streams/hlsManifestRewriter');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { formatResponse } = require('../src/modules/streams/streams.service');

const secret = 'playlist-only-proxy-local-fixture-secret-32';
const referer = 'https://page.example.test/watch';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const proxyApp = (proxy) => {
  const app = express();
  app.use('/stream-proxy', createHlsProxyRouter(proxy));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({
    code: error.code,
  }));
  return app;
};

test('rewriter sends only marked same-origin .ts segments direct', () => {
  const base = 'https://cdn.example.test/final/media.m3u8?token=root';
  const seen = [];
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=1"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'segment001.ts?sig=a%2Fb#part',
    '#EXTINF:4,',
    'https://cdn.example.test/final/absolute.ts?sig=2',
    '#EXTINF:4,',
    'unknown.bin',
    '#EXTINF:4,',
    'https://other.example.test/cross-origin.ts',
    '#EXT-X-PART:DURATION=0.5,URI="partial.ts"',
  ].join('\n');
  const output = rewriteHlsManifest(manifest, base, (url, kind) => {
    seen.push({ url, kind });
    return `/stream-proxy/opaque-${seen.length}`;
  }, { mode: 'playlists-only' });
  assert.match(output, /https:\/\/cdn\.example\.test\/final\/segment001\.ts\?sig=a%2Fb#part/);
  assert.match(output, /https:\/\/cdn\.example\.test\/final\/absolute\.ts\?sig=2/);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map(({ kind }) => kind), Array(5).fill('resource'));
  assert.match(output, /\/stream-proxy\/opaque-5/);
  assert.doesNotMatch(output, /https:\/\/other\.example\.test/);
  assert.throws(() => rewriteHlsManifest('#EXTM3U\n#EXTINF:4,\njavascript:alert(1)',
    base, () => '/proxy', { mode: 'playlists-only' }), /HLS_PROXY_INVALID_MANIFEST/);
  assert.throws(() => rewriteHlsManifest('#EXTM3U', base, () => '/proxy',
    { mode: 'unknown' }), /HLS_PROXY_INVALID_MANIFEST/);
});

test('signed mode keeps master and child playlists proxied while .ts bypasses backend',
  async (t) => {
    const seen = [];
    let base;
    const upstream = await listen((req, res) => {
      seen.push({ url: req.url, referer: req.headers.referer,
        range: req.headers.range });
      if (req.url === '/start.m3u8') {
        res.writeHead(302, { Location: '/final/master.m3u8' });
        return res.end();
      }
      if (req.url === '/final/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(req.headers.referer === referer
          ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8?token=c#frag'
          : '<html>not a playlist</html>');
      }
      if (req.url === '/final/child.m3u8?token=c') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(req.headers.referer === referer
          ? '#EXTM3U\n#EXTINF:4,\nsegment.ts?sig=a%2Fb#part\n#EXTINF:4,\nabsolute.ts?sig=2'
          : '<html>not a playlist</html>');
      }
      if (req.url.startsWith('/final/segment.ts') ||
          req.url.startsWith('/final/absolute.ts')) {
        if (req.headers.referer) return res.writeHead(403).end();
        res.writeHead(206, { 'Content-Type': 'video/mp2t',
          'Content-Range': 'bytes 0-3/8', 'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*' });
        return res.end('data');
      }
      res.writeHead(404); return res.end();
    });
    t.after(() => close(upstream));
    base = `http://127.0.0.1:${upstream.address().port}`;
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const resolver = createDirectHlsResolver({ httpClient: client });
    assert.deepEqual(await resolver.resolve({ providerId: 'local',
      url: `${base}/start.m3u8` }), []);
    const [resolved] = await resolver.resolve({ providerId: 'local',
      url: `${base}/start.m3u8`, headers: { referer } });
    assert.equal(resolved.validated, true);
    assert.equal(resolved.url, `${base}/final/master.m3u8`);
    assert.equal(resolved.headers.referer, referer);
    const stored = { id: crypto.randomUUID(), stream_url: resolved.url,
      playback_headers: { referer } };
    const codec = createHlsProxyTokenCodec({ secret });
    const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
      store: { findProxyStream: async (id) => id === stored.id ? stored : null },
      httpClient: client });
    const app = proxyApp(proxy);
    const api = formatResponse([{ ...stored, server_name: 'fixture', quality: 'auto',
      language: 'es-419', stream_type: 'direct', priority: 1 }], stored.id, 'movie', null,
    proxy, () => 'playlists-only');
    const playbackUrl = api.stream.url;
    assert.equal(codec.verify(playbackUrl.split('/').at(-1)).mode, 'playlists-only');
    assert.doesNotMatch(JSON.stringify(api), /page\.example\.test|\/final\/master\.m3u8/);
    assert.equal(proxy.createPlaybackUrl(stored, { mode: 'invalid' }), null);
    const master = await request(app).get(playbackUrl)
      .set('Referer', 'https://attacker.example.test/forged');
    assert.equal(master.status, 200);
    assert.equal(seen.at(-1).referer, referer);
    assert.doesNotMatch(master.text, /page\.example\.test|referer/i);
    const childPath = master.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
    assert.ok(childPath);
    assert.equal(codec.verify(childPath.split('/').at(-1)).mode, 'playlists-only');
    assert.equal(codec.verify(childPath.split('/').at(-1)).targetUrl,
      `${base}/final/child.m3u8?token=c#frag`);
    const child = await request(app).get(childPath)
      .set('Referer', 'https://attacker.example.test/forged');
    assert.equal(child.status, 200);
    assert.equal(seen.at(-1).referer, referer);
    assert.doesNotMatch(child.text, /page\.example\.test|referer|\/stream-proxy\//i);
    const direct = child.text.split('\n').filter((line) => line.startsWith(base));
    assert.deepEqual(direct, [
      `${base}/final/segment.ts?sig=a%2Fb#part`,
      `${base}/final/absolute.ts?sig=2`,
    ]);
    const backendCount = seen.length;
    const range = await fetch(direct[0], { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('access-control-allow-origin'), '*');
    assert.equal(await range.text(), 'data');
    assert.equal(seen.length, backendCount + 1);
    assert.equal(seen.at(-1).url, '/final/segment.ts?sig=a%2Fb');
    assert.equal(seen.at(-1).referer, undefined);
    assert.equal(seen.at(-1).range, 'bytes=0-3');
    assert.equal(seen.filter(({ url }) => url.includes('.m3u8')).length > 2, true);
  });

test('full mode remains default and refuses SSRF or client URL substitution', async (t) => {
  const upstream = await listen((_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts');
  });
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const stored = { id: crypto.randomUUID(), stream_url: `${base}/master.m3u8`,
    playback_headers: { referer } };
  const codec = createHlsProxyTokenCodec({ secret });
  const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const tokenPath = proxy.createPlaybackUrl(stored);
  assert.equal(codec.verify(tokenPath.split('/').at(-1)).mode, 'full');
  assert.throws(() => codec.issue({ streamId: stored.id,
    targetUrl: stored.stream_url, mode: 'invalid' }), { code: 'HLS_PROXY_TOKEN_INVALID' });
  const response = await request(proxyApp(proxy)).get(
    `${tokenPath}?url=http://127.0.0.1:1/private&mode=playlists-only`);
  assert.equal(response.status, 200);
  assert.match(response.text, /\/stream-proxy\//);
  assert.doesNotMatch(response.text, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const blocked = createHlsProxy({ enabled: true, tokenCodec: codec,
    store: { findProxyStream: async () => stored } });
  assert.equal((await request(proxyApp(blocked))
    .get(blocked.createPlaybackUrl(stored, { mode: 'playlists-only' }))).status, 502);
});

test('cross-origin playlist redirect never forwards Referer in playlists-only mode', async (t) => {
  const destination = await listen((req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(req.headers.referer === referer
      ? '#EXTM3U\n#EXTINF:4,\nsegment.ts' : '<html>no playlist</html>');
  });
  t.after(() => close(destination));
  const source = await listen((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/media.m3u8` });
    res.end();
  });
  t.after(() => close(source));
  const stored = { id: crypto.randomUUID(),
    stream_url: `http://127.0.0.1:${source.address().port}/master.m3u8`,
    playback_headers: { referer } };
  const proxy = createHlsProxy({ enabled: true, secret,
    store: { findProxyStream: async () => stored },
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const response = await request(proxyApp(proxy)).get(proxy.createPlaybackUrl(stored,
    { mode: 'playlists-only' }));
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(response.body), /page\.example\.test|\/media\.m3u8/);
});
