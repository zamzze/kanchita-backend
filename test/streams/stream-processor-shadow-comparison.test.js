'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'comparison-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'comparison-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'comparison-test-tmdb';

const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
const { createShadowLegacyComparator } =
  require('../../src/modules/streams/resolverV2/observability/shadowLegacyComparator');

const job = { content_type: 'movie', content_id: 'fixture', job_type: 'resolve' };
const shadowResult = {
  status: 'success', streamCount: 1, candidateCount: 1,
  selected: {
    protocol: 'hls', qualityTier: '1080p', languageTier: 'latino',
    validated: true, resolverStrategy: 'direct',
  },
};
const legacy = {
  url: 'https://legacy.example.test/master.m3u8', provider: 'legacy', strategy: 'browser',
  quality: '720p', audioLanguage: 'en', subtitleLanguage: null,
};
const dependencies = (overrides = {}) => ({
  db: { query: async () => { throw new Error('unexpected DB'); } },
  resolverExecutor: { shutdown: async () => {} },
  validator: async () => ({ valid: true }),
  findContent: async () => ({ tmdb_id: 1, title: 'Fixture' }),
  shadowResolver: { run: async () => shadowResult },
  providerManager: { resolve: async () => legacy },
  lifecycle: {
    readUsableCache: async () => ({ streams: null }),
    resolveAndPersist: async (_type, _id, content, resolve) => resolve({
      contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id, title: content.title,
    }),
  },
  stats: { recordReady: async () => {} },
  logger: { log: () => {}, warn: () => {} },
  ...overrides,
});

test('shadow comparison observes once while legacy remains authoritative', async () => {
  let shadowCalls = 0;
  let legacyCalls = 0;
  let comparatorCalls = 0;
  let recorded;
  const processor = createStreamProcessor(dependencies({
    shadowResolver: { run: async () => { shadowCalls += 1; return shadowResult; } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
    shadowComparator: { compare: (input) => {
      comparatorCalls += 1;
      assert.equal(input.shadow, shadowResult);
      assert.equal(input.legacy, legacy);
      return createShadowLegacyComparator().compare(input);
    } },
    comparisonStats: { record: (summary) => { recorded = summary; } },
    comparisonMetrics: { increment: async () => {} },
  }));
  const result = await processor(job);
  assert.equal(result, legacy);
  assert.equal(shadowCalls, 1);
  assert.equal(legacyCalls, 1);
  assert.equal(comparatorCalls, 1);
  assert.equal(recorded.wouldAvoidBrowser, true);
  assert.equal(recorded.qualityComparison, 'shadow_better');
});

test('comparator, stats and metric failures never alter legacy playback', async () => {
  for (const overrides of [
    { shadowComparator: { compare: () => { throw new Error('broken comparator'); } } },
    { comparisonStats: { record: () => { throw new Error('broken stats'); } } },
    { comparisonMetrics: { increment: () => { throw new Error('broken metrics'); } } },
  ]) {
    const result = await createStreamProcessor(dependencies(overrides))(job);
    assert.equal(result, legacy);
  }
});

test('a better validated shadow stream still returns legacy exactly once', async () => {
  let legacyCalls = 0;
  const processor = createStreamProcessor(dependencies({
    providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
    comparisonMetrics: { increment: async () => {} },
  }));
  assert.equal(await processor(job), legacy);
  assert.equal(legacyCalls, 1);
});
