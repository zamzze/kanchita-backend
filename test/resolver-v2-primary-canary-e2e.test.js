'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://canary:canary@127.0.0.1:5432/canary';
process.env.JWT_SECRET ||= 'canary-e2e-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'canary-e2e-refresh-secret';
process.env.TMDB_API_KEY ||= 'canary-e2e-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createPrimaryRolloutGate } =
  require('../src/modules/streams/resolverV2/primaryRolloutGate');
const { createPrimaryRuntimeGuard } =
  require('../src/modules/streams/resolverV2/health/primaryRuntimeGuard');
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

const makeProcessor = ({ runtime, rolloutGate, guard, onLegacy }) => createStreamProcessor({
  db: { query: async () => {} }, resolverExecutor: { shutdown: async () => {} },
  validator: async () => ({ valid: true }),
  findContent: async () => ({ tmdb_id: 10, title: 'Fixture' }),
  primaryEnabled: true, shadowEnabled: true, primaryRolloutGate: rolloutGate,
  primaryRuntimeGuard: guard, primaryResolver: runtime.primaryResolver,
  shadowResolver: { run: async () => { throw new Error('shadow must not run'); } },
  providerManager: { resolve: async () => { onLegacy(); return legacy; } },
  lifecycle: { readUsableCache: async () => ({ streams: null }),
    resolveAndPersist: async (_type, id, content, resolve) => resolve({
      contentType: 'movie', contentId: id, tmdbId: content.tmdb_id, title: content.title,
    }) },
  stats: { recordReady: async () => {} }, primaryMetrics: { increment: async () => {} },
  logger: { log: () => {}, warn: () => {} },
});

test('deterministic canary cohort avoids all V2 HTTP for non-selected content', async (t) => {
  let sourceRequests = 0;
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const source = await listen((_request, response) => {
    sourceRequests += 1;
    json(response, { sources: [{ url: `${media.url}/master.m3u8`, language: 'es-419' }] });
  });
  t.after(() => Promise.all([close(source.server), close(media.server)]));
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 1000, timeoutMs: 500,
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    httpProvider: { enabled: true, id: 'source_a', baseUrl: source.url, timeoutMs: 900 },
    logger: { log: () => {} } });
  const rolloutGate = createPrimaryRolloutGate({ enabled: true, rolloutPercent: 10,
    seed: 'canary-e2e' });
  let selectedId;
  let skippedId;
  for (let index = 0; (!selectedId || !skippedId) && index < 1000; index += 1) {
    const context = { contentType: 'movie', contentId: `movie-${index}`, tmdbId: 10,
      title: 'Fixture' };
    if (rolloutGate.evaluate(context).eligible) selectedId ||= context.contentId;
    else skippedId ||= context.contentId;
  }
  let legacyCalls = 0;
  const processor = makeProcessor({ runtime, rolloutGate,
    guard: createPrimaryRuntimeGuard(), onLegacy: () => { legacyCalls += 1; } });
  assert.equal(await processor({ content_type: 'movie', content_id: skippedId,
    job_type: 'resolve' }), legacy);
  assert.equal(sourceRequests, 0);
  const selectedResult = await processor({ content_type: 'movie', content_id: selectedId,
    job_type: 'resolve' });
  assert.equal(selectedResult.url, `${media.url}/master.m3u8`);
  assert.equal(sourceRequests, 1);
  assert.equal(legacyCalls, 1);
});

test('systemic primary timeouts open guard, bypass V2, then recover with one probe', async (t) => {
  let sourceRequests = 0;
  let healthy = false;
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const source = await listen((_request, response) => {
    sourceRequests += 1;
    if (healthy) return json(response, { sources: [{ url: `${media.url}/master.m3u8` }] });
    setTimeout(() => { if (!response.destroyed) json(response, { sources: [] }); }, 700).unref();
  });
  t.after(() => Promise.all([close(source.server), close(media.server)]));
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 500, timeoutMs: 500,
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    httpProvider: { enabled: true, id: 'source_a', baseUrl: source.url, timeoutMs: 900 },
    logger: { log: () => {} } });
  let now = 1_000;
  const guard = createPrimaryRuntimeGuard({ minimumAttempts: 3, windowSize: 3,
    failureRateThreshold: 50, timeoutRateThreshold: 40, cooldownMs: 10_000,
    clock: () => now });
  let legacyCalls = 0;
  const processor = makeProcessor({ runtime,
    rolloutGate: createPrimaryRolloutGate({ enabled: true, rolloutPercent: 100,
      seed: 'guard-e2e' }), guard, onLegacy: () => { legacyCalls += 1; } });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await processor({ content_type: 'movie', content_id: `failure-${index}`,
      job_type: 'resolve' }), legacy);
  }
  assert.equal(guard.snapshot().state, 'open');
  assert.equal(sourceRequests, 3);
  assert.equal(await processor({ content_type: 'movie', content_id: 'blocked',
    job_type: 'resolve' }), legacy);
  assert.equal(sourceRequests, 3);
  healthy = true;
  now += 10_000;
  const result = await processor({ content_type: 'movie', content_id: 'probe',
    job_type: 'resolve' });
  assert.equal(result.url, `${media.url}/master.m3u8`);
  assert.equal(guard.snapshot().state, 'closed');
  assert.equal(sourceRequests, 4);
  assert.equal(legacyCalls, 4);
});
