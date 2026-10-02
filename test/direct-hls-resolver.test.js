'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  createDirectHlsResolver,
  isHlsContentType,
} = require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');

const fixtureDirectory = path.join(__dirname, 'fixtures', 'streams');
const fixture = (name) => fs.readFileSync(path.join(fixtureDirectory, name), 'utf8');
const master = fixture('master-simple.m3u8');
const media = fixture('media-playlist.m3u8');
const invalid = fixture('invalid-not-hls.txt');

let firstServer;
let secondServer;
let firstUrl;
let secondUrl;
let requests;
let secondRequests;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});
const count = (method, pathname) => requests
  .filter((entry) => entry.method === method && entry.pathname === pathname).length;
const candidate = (url, overrides = {}) => ({
  providerId: 'fixture_provider', url, headers: {}, ...overrides,
});
const createResolver = (options = {}) => createDirectHlsResolver({
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 500 }),
  timeoutMs: 300,
  ...options,
});
const rejectsWithCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

before(async () => {
  secondServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    secondRequests.push({ method: request.method, pathname: url.pathname, headers: request.headers });
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.setHeader('set-cookie', 'fixture=server-only');
    response.end(master);
  });
  await listen(secondServer);
  secondUrl = `http://127.0.0.1:${secondServer.address().port}`;

  firstServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    const pathname = url.pathname;
    requests.push({ method: request.method, pathname, headers: request.headers });

    const hls = (body = master) => {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl; charset=utf-8');
      response.end(body);
    };
    if (pathname.toLowerCase() === '/master.m3u8') return hls(master);
    if (pathname === '/media.m3u8') return hls(media);
    if (pathname === '/multiaudio.m3u8') return hls(fixture('master-multiaudio.m3u8'));
    if (pathname === '/subtitles.m3u8') return hls(fixture('master-subtitles.m3u8'));
    if (pathname === '/invalid.m3u8') return response.end(invalid);
    if (pathname === '/large.m3u8') return hls(`#EXTM3U\n${'x'.repeat(4096)}`);
    if (pathname === '/slow-get.m3u8') return setTimeout(() => hls(master), 100);
    if (pathname === '/abort-get.m3u8') return setTimeout(() => hls(master), 100);

    if (pathname === '/redirect' || pathname === '/redirect-relative') {
      response.writeHead(302, { Location: '/master.m3u8' });
      return response.end();
    }
    if (pathname === '/cross-origin') {
      response.writeHead(302, { Location: `${secondUrl}/target/master.m3u8` });
      return response.end();
    }
    if (pathname === '/not-found') {
      response.writeHead(404);
      return response.end('missing');
    }
    if (pathname === '/html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      return response.end(invalid);
    }
    if (pathname === '/head-405' || pathname === '/head-403' || pathname === '/head-501') {
      if (request.method === 'HEAD') {
        response.writeHead(Number(pathname.slice(-3)));
        return response.end();
      }
      return hls(master);
    }
    if (pathname === '/hls-content-invalid') return request.method === 'HEAD'
      ? hls('') : response.end(invalid);
    if (pathname === '/no-extension') return hls(master);
    if (pathname === '/octet') {
      response.setHeader('content-type', 'application/octet-stream');
      return response.end(master);
    }
    if (pathname === '/plain') {
      response.setHeader('content-type', 'text/plain');
      return response.end(master);
    }
    if (pathname === '/header-check') return hls(master);
    if (pathname === '/slow-head') return request.method === 'HEAD'
      ? setTimeout(() => hls(''), 100) : hls(master);
    if (pathname === '/abort-head') return request.method === 'HEAD'
      ? setTimeout(() => hls(''), 100) : hls(master);
    if (pathname === '/deadline') return request.method === 'HEAD'
      ? setTimeout(() => hls(''), 25) : setTimeout(() => hls(master), 50);
    response.writeHead(404);
    return response.end();
  });
  await listen(firstServer);
  firstUrl = `http://127.0.0.1:${firstServer.address().port}`;
});

beforeEach(() => {
  requests = [];
  secondRequests = [];
});

after(async () => {
  await Promise.all([close(firstServer), close(secondServer)]);
});

test('canResolve is a pure generic HTTP probe without extension restriction', () => {
  const resolver = createResolver();
  assert.equal(resolver.canResolve(candidate(`${firstUrl}/master.m3u8`)), true);
  assert.equal(resolver.canResolve(candidate(`${firstUrl}/no-extension`)), true);
  assert.equal(resolver.canResolve(candidate('ftp://invalid.example.test/file')), false);
  assert.equal(count('GET', '/master.m3u8'), 0);
  assert.equal(count('HEAD', '/no-extension'), 0);
});

test('.m3u8 fast path performs GET only and creates a normalized master candidate', async () => {
  const [stream] = await createResolver().resolve(candidate(
    `${firstUrl}/master.M3U8?token=synthetic#fragment`,
    { qualityHint: '1080p', languageHint: 'es-419' }
  ));
  assert.equal(count('HEAD', '/master.M3U8'), 0);
  assert.equal(count('GET', '/master.M3U8'), 1);
  assert.equal(stream.protocol, 'hls');
  assert.equal(stream.providerId, 'fixture_provider');
  assert.equal(stream.resolverId, 'direct_hls');
  assert.equal(stream.validated, true);
  assert.equal(stream.hlsInfo.isMaster, true);
  assert.equal(stream.quality, '1080p');
  assert.equal(stream.audioLanguage, 'es-419');
  assert.equal(stream.subtitleLanguage, null);
  assert.equal(stream.expiresAt, null);
  assert.ok(stream.latencyMs >= 0);
});

test('media playlists, multiaudio and subtitles remain structured without selection', async () => {
  const resolver = createResolver();
  const [mediaStream] = await resolver.resolve(candidate(`${firstUrl}/media.m3u8`));
  assert.equal(mediaStream.hlsInfo.isMediaPlaylist, true);

  const [audioStream] = await resolver.resolve(candidate(`${firstUrl}/multiaudio.m3u8`));
  assert.deepEqual(audioStream.hlsInfo.audioTracks.map(({ language }) => language),
    ['es-419', 'en', 'es']);
  assert.equal(audioStream.audioLanguage, null);

  const [subtitleStream] = await resolver.resolve(candidate(`${firstUrl}/subtitles.m3u8`));
  assert.deepEqual(subtitleStream.hlsInfo.subtitleTracks.map(({ language }) => language),
    ['es', 'en']);
  assert.equal(subtitleStream.subtitleLanguage, null);
});

test('HEAD content sniffing accepts HLS, octet-stream and text/plain', async () => {
  assert.equal(isHlsContentType('Application/Vnd.Apple.MpegURL; charset=utf-8'), true);
  const resolver = createResolver();
  for (const pathname of ['/no-extension', '/octet', '/plain']) {
    const streams = await resolver.resolve(candidate(`${firstUrl}${pathname}`));
    assert.equal(streams.length, 1, pathname);
    assert.equal(count('HEAD', pathname), 1, pathname);
    assert.equal(count('GET', pathname), 1, pathname);
  }
});

test('HTML HEAD and ordinary failing status return [] without a GET', async () => {
  const resolver = createResolver();
  assert.deepEqual(await resolver.resolve(candidate(`${firstUrl}/html`)), []);
  assert.equal(count('HEAD', '/html'), 1);
  assert.equal(count('GET', '/html'), 0);
  assert.deepEqual(await resolver.resolve(candidate(`${firstUrl}/not-found`)), []);
  assert.equal(count('HEAD', '/not-found'), 1);
  assert.equal(count('GET', '/not-found'), 0);
});

test('HEAD 403, 405 and 501 fall back to a bounded GET', async () => {
  const resolver = createResolver();
  for (const pathname of ['/head-403', '/head-405', '/head-501']) {
    assert.equal((await resolver.resolve(candidate(`${firstUrl}${pathname}`))).length, 1);
    assert.equal(count('HEAD', pathname), 1);
    assert.equal(count('GET', pathname), 1);
  }
});

test('invalid manifests return [] whether extension or HLS Content-Type suggested HLS', async () => {
  const resolver = createResolver();
  assert.deepEqual(await resolver.resolve(candidate(`${firstUrl}/invalid.m3u8`)), []);
  assert.deepEqual(await resolver.resolve(candidate(`${firstUrl}/hls-content-invalid`)), []);
});

test('redirects preserve the final playable URL', async () => {
  const resolver = createResolver();
  for (const pathname of ['/redirect', '/redirect-relative']) {
    const [stream] = await resolver.resolve(candidate(`${firstUrl}${pathname}`));
    assert.equal(stream.url, `${firstUrl}/master.m3u8`);
  }
});

test('candidate playback headers reach requests and no response cookie is promoted', async () => {
  const input = candidate(`${firstUrl}/header-check`, {
    referer: 'https://catalog.example.test/title',
    origin: 'https://catalog.example.test',
    headers: {
      'User-Agent': 'Fixture-Player/1', Accept: 'application/x-mpegurl',
      'Accept-Language': 'es-419', Range: 'bytes=0-1023', 'X-Test': 'safe',
    },
  });
  const [stream] = await createResolver().resolve(input);
  const get = requests.find(({ method, pathname }) => method === 'GET' && pathname === '/header-check');
  assert.equal(get.headers['user-agent'], 'Fixture-Player/1');
  assert.equal(get.headers.referer, input.referer);
  assert.equal(get.headers.origin, input.origin);
  assert.equal(get.headers.range, 'bytes=0-1023');
  assert.equal(stream.headers['user-agent'], 'Fixture-Player/1');
  assert.equal(stream.headers.referer, input.referer);
  assert.equal(stream.headers.origin, input.origin);
  assert.equal(stream.headers.cookie, undefined);
  assert.equal(stream.headers['set-cookie'], undefined);
});

test('cross-origin redirect strips credentials but preserves legitimate playback headers', async () => {
  const input = candidate(`${firstUrl}/cross-origin`, {
    referer: 'https://catalog.example.test/title',
    origin: 'https://catalog.example.test',
    headers: {
      Authorization: 'Bearer synthetic', Cookie: 'fixture=synthetic',
      'Proxy-Authorization': 'Basic synthetic', 'User-Agent': 'Fixture-Player/2',
      'X-Test': 'safe',
    },
  });
  const [stream] = await createResolver().resolve(input);
  assert.equal(stream.url, `${secondUrl}/target/master.m3u8`);
  for (const name of ['authorization', 'cookie', 'proxy-authorization']) {
    assert.equal(stream.headers[name], undefined);
  }
  assert.equal(stream.headers['user-agent'], 'Fixture-Player/2');
  assert.equal(stream.headers.referer, input.referer);
  assert.equal(stream.headers.origin, input.origin);
  const finalGet = secondRequests.find(({ method }) => method === 'GET');
  assert.equal(finalGet.headers.authorization, undefined);
  assert.equal(finalGet.headers.cookie, undefined);
  assert.equal(finalGet.headers['proxy-authorization'], undefined);
});

test('manifest overflow, timeout and one HEAD+GET deadline remain operational errors', async () => {
  await rejectsWithCode(createResolver({ maxManifestBytes: 512 })
    .resolve(candidate(`${firstUrl}/large.m3u8`)), 'HTTP_RESPONSE_TOO_LARGE');
  await rejectsWithCode(createResolver({ timeoutMs: 30 })
    .resolve(candidate(`${firstUrl}/slow-get.m3u8`)), 'HTTP_TIMEOUT');
  const startedAt = Date.now();
  await rejectsWithCode(createResolver({ timeoutMs: 60 })
    .resolve(candidate(`${firstUrl}/deadline`)), 'HTTP_TIMEOUT');
  assert.ok(Date.now() - startedAt < 120);
});

test('AbortSignal propagates before and during HEAD or GET', async () => {
  const resolver = createResolver();
  const preAborted = new AbortController();
  preAborted.abort();
  await rejectsWithCode(resolver.resolve(candidate(`${firstUrl}/master.m3u8`), {
    signal: preAborted.signal,
  }), 'HTTP_ABORTED');

  for (const pathname of ['/abort-head', '/abort-get.m3u8']) {
    const controller = new AbortController();
    const pending = resolver.resolve(candidate(`${firstUrl}${pathname}`), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);
    await rejectsWithCode(pending, 'HTTP_ABORTED');
  }
});

test('resolver and registry remain isolated from browser and production flow', () => {
  const files = [
    path.join(__dirname, '..', 'src', 'modules', 'streams', 'resolverV2', 'resolverRegistry.js'),
    path.join(__dirname, '..', 'src', 'modules', 'streams', 'resolverV2', 'resolvers',
      'directHlsResolver.js'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source,
      /puppeteer|puppeteer-real-browser|ProviderC|providerC|resolverExecutor|browserSlots/);
    assert.doesNotMatch(source, /streamProcessor|providerManager|streamResolutionWorker|\bpg\b/);
  }
});
