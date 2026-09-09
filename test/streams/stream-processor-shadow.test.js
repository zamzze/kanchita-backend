'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'shadow-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'shadow-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'shadow-test-tmdb';

const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
const { createSafeHttpClient } = require('../../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../../src/modules/streams/resolverV2/createShadowPipeline');

const job = { content_type: 'movie', content_id: 'movie-fixture', job_type: 'resolve' };
const content = { tmdb_id: 10, title: 'Fixture' };
const legacyStream = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
const dependencies = ({ shadowResolver, providerManager } = {}) => ({
  db: { query: async () => { throw new Error('unexpected DB access'); } },
  resolverExecutor: { shutdown: async () => {} },
  validator: async () => ({ valid: true }),
  findContent: async () => content,
  shadowResolver,
  providerManager,
  lifecycle: {
    readUsableCache: async () => ({ streams: null }),
    resolveAndPersist: async (contentType, contentId, metadata, resolve) => resolve({
      contentType, contentId, tmdbId: metadata.tmdb_id,
      title: metadata.title || metadata.series_title,
      season: metadata.season_number, episode: metadata.episode_number,
    }),
  },
  stats: { recordReady: async () => {} },
  logger: { log: () => {}, warn: () => {} },
});

test('all shadow outcomes and unexpected throws leave legacy authoritative', async () => {
  for (const behavior of [
    async () => ({ status: 'success', streamCount: 1 }),
    async () => ({ status: 'no_streams', streamCount: 0 }),
    async () => ({ status: 'failed' }),
    async () => ({ status: 'timeout' }),
    async () => { throw new Error('unexpected shadow bug'); },
  ]) {
    let shadowCalls = 0;
    let legacyCalls = 0;
    let legacyContext;
    const shadowResolver = { run: async (context) => {
      shadowCalls += 1;
      context.title = 'mutated-by-shadow';
      return behavior();
    } };
    const providerManager = { resolve: async (context) => {
      legacyCalls += 1;
      legacyContext = context;
      return legacyStream;
    } };
    const processor = createStreamProcessor(dependencies({ shadowResolver, providerManager }));
    const result = await processor(job);
    assert.equal(result, legacyStream);
    assert.equal(shadowCalls, 1);
    assert.equal(legacyCalls, 1);
    assert.equal(legacyContext.title, 'Fixture');
  }
});

test('refresh skips shadow while retaining legacy behavior', async () => {
  let shadowCalls = 0;
  let legacyCalls = 0;
  const processor = createStreamProcessor(dependencies({
    shadowResolver: { run: async () => { shadowCalls += 1; } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacyStream; } },
  }));
  assert.equal(await processor({ ...job, job_type: 'refresh' }), legacyStream);
  assert.equal(shadowCalls, 0);
  assert.equal(legacyCalls, 1);
});

test('legacy failure remains authoritative after shadow observation', async () => {
  const processor = createStreamProcessor(dependencies({
    shadowResolver: { run: async () => ({ status: 'success' }) },
    providerManager: { resolve: async () => {
      throw Object.assign(new Error('legacy failed'), { code: 'RESOLUTION_FAILED' });
    } },
  }));
  await assert.rejects(processor(job), (error) => error.code === 'RESOLUTION_FAILED');
});

test('synthetic shadow finds a different HLS stream but processor returns legacy', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const shadowUrl = `http://127.0.0.1:${server.address().port}/shadow.m3u8`;
  const composition = createShadowPipeline({
    enabled: true,
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    sourceProviders: [{
      descriptor: {
        id: 'fixture_source', active: true, priority: 10, supportsMovies: true,
        supportsEpisodes: true, languages: [], strategy: 'static', timeoutMs: 100,
        maxCandidates: 1,
      },
      getSources: async () => [{ providerId: 'ignored', url: shadowUrl, headers: {} }],
    }],
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
    timeoutMs: 500,
  });
  let shadowResult;
  let legacyCalls = 0;
  const processor = createStreamProcessor(dependencies({
    shadowResolver: { run: async (context) => {
      shadowResult = await composition.shadowResolver.run(context);
      return shadowResult;
    } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacyStream; } },
  }));
  const result = await processor(job);
  assert.equal(shadowResult.status, 'success');
  assert.equal(shadowResult.streamCount, 1);
  assert.equal(result, legacyStream);
  assert.notEqual(result.url, shadowUrl);
  assert.equal(legacyCalls, 1);
});
