'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createV2Observability } =
  require('../src/modules/streams/resolverV2/observability/v2Observability');
const { createShadowResolver } =
  require('../src/modules/streams/resolverV2/shadowResolver');

const media = { contentType: 'movie', contentId: 'fixture', tmdbId: 1, title: 'Fixture' };

test('collector exposes only static latency series and bounded counters', () => {
  const observability = createV2Observability({ maxSamples: 3 });
  for (let index = 0; index < 10; index += 1) observability.observe('source_http', index);
  observability.increment('source_circuit_open');
  const snapshot = observability.snapshot();
  assert.equal(snapshot.latency.source_http.count, 3);
  assert.equal(snapshot.counters.source_circuit_open, 1);
  assert.deepEqual(Object.keys(snapshot.latency), [
    'source_http', 'resolver_http', 'resolver_direct', 'shadow_total',
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot),
    /https?:|authorization|cookie|token|title|tmdbId|contentId|query/i);
});

test('shadow records total latency and observability failures never affect its result', async () => {
  const observability = createV2Observability();
  const pipeline = { resolve: async () => ({
    streams: [],
    sourceTrace: { providersAttempted: 1, candidateCount: 0 },
    resolverTrace: { attempts: [], durationMs: 0 },
  }) };
  const shadow = createShadowResolver({
    pipeline, enabled: true, observability,
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
  });
  assert.equal((await shadow.run(media)).status, 'no_candidates');
  assert.equal(observability.snapshot().latency.shadow_total.count, 1);

  const broken = createShadowResolver({
    pipeline, enabled: true, observability: { observe: () => { throw new Error('broken'); } },
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
  });
  assert.equal((await broken.run(media)).status, 'no_candidates');
});
