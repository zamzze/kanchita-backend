'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'health-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'health-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'health-test-tmdb';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');
const { createV2HealthStore } =
  require('../src/modules/streams/resolverV2/health/v2HealthStore');

test('an open V2 circuit cannot change authoritative legacy playback', async () => {
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 1000 });
  health.canAttempt('resolver', 'resolver_a');
  health.recordFailure('resolver', 'resolver_a', { errorCode: 'HTTP_TIMEOUT' });
  let legacyCalls = 0;
  const legacyStream = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
  const processor = createStreamProcessor({
    db: { query: async () => { throw new Error('unexpected DB'); } },
    resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 1, title: 'Fixture' }),
    shadowResolver: { run: async () => {
      assert.equal(health.canAttempt('resolver', 'resolver_a'), false);
      return { status: 'no_streams', streamCount: 0, candidateCount: 1 };
    } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacyStream; } },
    lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id,
        title: content.title,
      }),
    },
    stats: { recordReady: async () => {} },
    logger: { log: () => {}, warn: () => {} },
  });
  const result = await processor({
    content_type: 'movie', content_id: 'fixture', job_type: 'resolve',
  });
  assert.equal(result, legacyStream);
  assert.equal(legacyCalls, 1);
});
