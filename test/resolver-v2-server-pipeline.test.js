'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'shadow-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'shadow-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'shadow-test-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const mediaContext = {
  contentType: 'movie', contentId: 'movie-server', tmdbId: 42, title: 'Fixture',
};

const fixtureNetwork = async (t, { mixed = false } = {}) => {
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nmedia.m3u8\n');
  });
  const resolver = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ streams: [{
      url: `${media.url}/resolved.m3u8`, protocol: 'hls', quality: '1080p',
      audioLanguage: 'es-419',
    }] }));
  });
  const source = await listen((_request, response) => {
    const sources = [{ url: `${resolver.url}/item/abc` }];
    if (mixed) sources.unshift({ url: `${media.url}/direct.m3u8`, quality: '720p' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ sources }));
  });
  t.after(() => Promise.all([close(source.server), close(resolver.server), close(media.server)]));
  return { source, resolver, media };
};

const compositionFor = (network) => createShadowPipeline({
  enabled: true,
  timeoutMs: 3000,
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
  httpProvider: {
    enabled: true, id: 'source_a', baseUrl: network.source.url,
    timeoutMs: 1500, maxCandidates: 8,
  },
  httpResolver: {
    enabled: true, id: 'resolver_a', domains: ['127.0.0.1'],
    timeoutMs: 1500, maxStreams: 4,
  },
  metrics: { increment: async () => {}, observe: async () => {} },
  logger: { log: () => {} },
});

test('invalid enabled HTTP resolver configuration is not registered', () => {
  const composition = createShadowPipeline({
    enabled: true,
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    httpResolver: { enabled: true, domains: 'https://invalid.example.test/path' },
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
  });
  assert.deepEqual(composition.resolverRegistry.list().map(({ descriptor }) => descriptor.id),
    ['direct_hls', 'direct_mp4']);
});
test('SourceProvider to declarative server resolver to validated HLS works in shadow', async (t) => {
  const network = await fixtureNetwork(t);
  const composition = compositionFor(network);
  assert.deepEqual(composition.resolverRegistry.list().map(({ descriptor }) => descriptor.id),
    ['resolver_a', 'direct_hls', 'direct_mp4']);
  const result = await composition.shadowResolver.run(mediaContext);
  assert.equal(result.status, 'success');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.streamCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /http:|headers|cookie|authorization|item\/abc/i);
});

test('direct and configured-server candidates coexist without resolver collision', async (t) => {
  const network = await fixtureNetwork(t, { mixed: true });
  const composition = compositionFor(network);
  const resolved = await composition.pipeline.resolve(mediaContext);
  assert.equal(resolved.streams.length, 2);
  assert.deepEqual(resolved.streams.map(({ resolverId }) => resolverId),
    ['resolver_a', 'direct_hls']);
  assert.ok(resolved.streams.every(({ validated }) => validated));
});

test('extensionless direct HLS remains on the generic direct resolver path', async (t) => {
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
  });
  t.after(() => close(media.server));
  const direct = createDirectHlsResolver({
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
  });
  const registry = createResolverRegistry([direct]);
  assert.deepEqual(registry.detect({
    providerId: 'source_a', url: `${media.url}/play/abc`, headers: {},
  }).map(({ descriptor }) => descriptor.id), ['direct_hls']);
  const engine = createResolverEngine({ registry, timeoutMs: 2000 });
  const result = await engine.resolve({
    mediaContext,
    candidates: [{ providerId: 'source_a', url: `${media.url}/play/abc`, headers: {} }],
  });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].resolverId, 'direct_hls');
  assert.equal(result.streams[0].validated, true);
});
test('full shadow server path remains observational and legacy wins playback', async (t) => {
  const network = await fixtureNetwork(t);
  const composition = compositionFor(network);
  const legacyStream = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
  let shadowResult;
  let legacyCalls = 0;
  let dbWrites = 0;
  const processor = createStreamProcessor({
    db: { query: async () => { dbWrites += 1; throw new Error('unexpected DB'); } },
    resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 42, title: 'Fixture' }),
    shadowResolver: { run: async (context) => {
      shadowResult = await composition.shadowResolver.run(context); return shadowResult;
    } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacyStream; } },
    lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        ...mediaContext, tmdbId: content.tmdb_id, title: content.title,
      }),
    },
    stats: { recordReady: async () => {} },
    logger: { log: () => {}, warn: () => {} },
  });
  const result = await processor({
    content_type: 'movie', content_id: 'movie-server', job_type: 'resolve',
  });
  assert.equal(shadowResult.status, 'success');
  assert.equal(shadowResult.streamCount, 1);
  assert.equal(result, legacyStream);
  assert.equal(legacyCalls, 1);
  assert.equal(dbWrites, 0);
});

test('engine and pipeline contain no scattered server hostname conditions or browser imports', () => {
  for (const relative of ['resolverEngine.js', 'resolutionPipeline.js', 'sourceProviderManager.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
      'resolverV2', relative), 'utf8');
    assert.doesNotMatch(text, /resolver-a|resolver-b|url\.includes|ProviderC|puppeteer|browserSlots/i);
  }
});
