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
const media = { contentType: 'movie', contentId: 'movie-http', tmdbId: 10, title: 'Fixture' };

test('configured HTTP source resolves in shadow while legacy remains authoritative', async (t) => {
  let hlsCalls = 0;
  const mediaServer = await listen((_request, response) => {
    hlsCalls += 1;
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
  });
  let sourceCalls = 0;
  const sourceToken = 'Bearer source-fixture-secret';
  const sourceServer = await listen((request, response) => {
    sourceCalls += 1;
    assert.equal(request.url, '/sources/movie/10');
    assert.equal(request.headers.authorization, sourceToken);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ sources: [{
      url: `${mediaServer.url}/master.m3u8`, language: 'es-419', quality: '1080p',
    }] }));
  });
  t.after(() => Promise.all([close(sourceServer.server), close(mediaServer.server)]));

  const composition = createShadowPipeline({
    enabled: true,
    timeoutMs: 3000,
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    httpProvider: {
      enabled: true, id: 'provider_a', baseUrl: sourceServer.url,
      timeoutMs: 1500, maxCandidates: 8, headers: { authorization: sourceToken },
    },
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
  });
  const shadowResult = await composition.shadowResolver.run(media);
  assert.equal(shadowResult.status, 'success');
  assert.equal(shadowResult.streamCount, 1);
  assert.equal(shadowResult.candidateCount, 1);
  assert.equal(sourceCalls, 1);
  assert.equal(hlsCalls, 1);
  assert.doesNotMatch(JSON.stringify(shadowResult), /source-fixture-secret|authorization|http:/i);

  const legacyStream = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
  let observed;
  let legacyCalls = 0;
  const processor = createStreamProcessor({
    db: { query: async () => { throw new Error('unexpected DB access'); } },
    resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 10, title: 'Fixture' }),
    shadowResolver: { run: async (context) => {
      observed = await composition.shadowResolver.run(context); return observed;
    } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacyStream; } },
    lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        contentType: 'movie', contentId: 'movie-http', tmdbId: content.tmdb_id,
        title: content.title,
      }),
    },
    stats: { recordReady: async () => {} },
    logger: { log: () => {}, warn: () => {} },
  });
  const result = await processor({
    content_type: 'movie', content_id: 'movie-http', job_type: 'resolve',
  });
  assert.equal(observed.status, 'success');
  assert.equal(result, legacyStream);
  assert.equal(legacyCalls, 1);
  assert.notEqual(result.url, `${mediaServer.url}/master.m3u8`);
});
