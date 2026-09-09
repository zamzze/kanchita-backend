'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://primary:primary@127.0.0.1:5432/primary';
process.env.JWT_SECRET ||= 'primary-e2e-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'primary-e2e-refresh-secret';
process.env.TMDB_API_KEY ||= 'primary-e2e-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, body) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const legacy = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };

const runtimeFor = (sourceUrl, options = {}) => createShadowPipeline({
  enabled: false,
  primaryEnabled: true,
  primaryTimeoutMs: options.primaryTimeoutMs || 1000,
  timeoutMs: 500,
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
  httpProvider: {
    enabled: true, id: 'source_a', baseUrl: sourceUrl,
    timeoutMs: options.providerTimeoutMs || 900, maxCandidates: 8,
  },
  httpResolver: options.httpResolver || {},
  logger: { log: () => {} },
});

const processorFor = (runtime, onLegacy = () => {}) => createStreamProcessor({
  db: { query: async () => { throw new Error('unexpected DB'); } },
  resolverExecutor: { shutdown: async () => {} },
  validator: async () => ({ valid: true }),
  findContent: async () => ({ tmdb_id: 10, title: 'Fixture' }),
  primaryEnabled: true,
  shadowEnabled: true,
  primaryResolver: runtime.primaryResolver,
  primaryStats: runtime.primaryStats,
  shadowResolver: { run: async () => { throw new Error('shadow must not run'); } },
  providerManager: { resolve: async () => { onLegacy(); return legacy; } },
  lifecycle: {
    readUsableCache: async () => ({ streams: null }),
    resolveAndPersist: async (_type, _id, content, resolve) => resolve({
      contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id, title: content.title,
    }),
  },
  stats: { recordReady: async () => {} },
  logger: { log: () => {}, warn: () => {} },
});
const run = (processor) => processor({
  content_type: 'movie', content_id: 'fixture', job_type: 'resolve',
});

test('configured source to direct HLS becomes primary without legacy/browser', async (t) => {
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
  });
  const source = await listen((_request, response) => json(response, { sources: [{
    url: `${media.url}/master.m3u8`, language: 'es-419', quality: '1080p',
  }] }));
  t.after(() => Promise.all([close(source.server), close(media.server)]));
  const runtime = runtimeFor(source.url);
  let legacyCalls = 0;
  const result = await run(processorFor(runtime, () => { legacyCalls += 1; }));
  assert.equal(result.url, `${media.url}/master.m3u8`);
  assert.equal(result.quality, '1080p');
  assert.equal(result.language, 'es-419');
  assert.equal(result.validated, true);
  assert.equal(legacyCalls, 0);
  assert.equal(runtime.primaryStats.snapshot().legacyAvoided, 1);
});

test('configured server resolver path can become primary without legacy', async (t) => {
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
  });
  const resolver = await listen((_request, response) => json(response, { streams: [{
    url: `${media.url}/resolved.m3u8`, protocol: 'hls', quality: '720p',
    audioLanguage: 'es-419',
  }] }));
  const source = await listen((_request, response) => json(response, { sources: [{
    url: `${resolver.url}/item/10`,
  }] }));
  t.after(() => Promise.all([close(source.server), close(resolver.server), close(media.server)]));
  const runtime = runtimeFor(source.url, { httpResolver: {
    enabled: true, id: 'resolver_a', domains: ['127.0.0.1'], timeoutMs: 900,
  } });
  let legacyCalls = 0;
  const result = await run(processorFor(runtime, () => { legacyCalls += 1; }));
  assert.equal(result.url, `${media.url}/resolved.m3u8`);
  assert.equal(result.provider, 'source_a');
  assert.equal(legacyCalls, 0);
});

test('header-bound and invalid HLS candidates fall back to legacy', async (t) => {
  let sources = [];
  const media = await listen((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(request.url.includes('invalid') ? '<html>not hls</html>' : '#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const source = await listen((_request, response) => json(response, { sources }));
  t.after(() => Promise.all([close(source.server), close(media.server)]));

  for (const fixture of [
    { url: `${media.url}/header.m3u8`, headers: { Referer: 'https://player.example.test/' } },
    { url: `${media.url}/invalid.m3u8` },
  ]) {
    sources = [fixture];
    const runtime = runtimeFor(source.url);
    let legacyCalls = 0;
    assert.equal(await run(processorFor(runtime, () => { legacyCalls += 1; })), legacy);
    assert.equal(legacyCalls, 1);
  }
});

test('primary ranking promotes Latino 720p over English 1080p', async (t) => {
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const source = await listen((_request, response) => json(response, { sources: [
    { url: `${media.url}/english.m3u8`, language: 'en', quality: '1080p' },
    { url: `${media.url}/latino.m3u8`, language: 'es-419', quality: '720p' },
  ] }));
  t.after(() => Promise.all([close(source.server), close(media.server)]));
  const result = await run(processorFor(runtimeFor(source.url)));
  assert.equal(result.url, `${media.url}/latino.m3u8`);
  assert.equal(result.quality, '720p');
});

test('primary global timeout aborts V2 before one legacy fallback', async (t) => {
  let requestClosed = false;
  const source = await listen((request, response) => {
    request.on('close', () => { requestClosed = true; });
    setTimeout(() => {
      if (!response.destroyed) json(response, { sources: [] });
    }, 700).unref();
  });
  t.after(() => close(source.server));
  const runtime = runtimeFor(source.url, { primaryTimeoutMs: 500, providerTimeoutMs: 900 });
  let legacyCalls = 0;
  const result = await run(processorFor(runtime, () => { legacyCalls += 1; }));
  assert.equal(result, legacy);
  assert.equal(legacyCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requestClosed, true);
});
