'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLatencyHistogram } =
  require('../src/modules/streams/resolverV2/observability/latencyHistogram');

test('empty and populated histograms expose bounded descriptive statistics', () => {
  const histogram = createLatencyHistogram({ maxSamples: 8 });
  assert.deepEqual(histogram.snapshot('source_http'), {
    count: 0, min: null, max: null, avg: null, p50: null, p95: null,
  });
  for (const value of [1, 2, 3, 4, 100]) histogram.observe('source_http', value);
  assert.deepEqual(histogram.snapshot('source_http'), {
    count: 5, min: 1, max: 100, avg: 22, p50: 3, p95: 100,
  });
});

test('ring buffer evicts old samples and remains bounded after 10000 observations', () => {
  const histogram = createLatencyHistogram({ maxSamples: 4 });
  for (let value = 0; value < 10_000; value += 1) histogram.observe('resolver_http', value);
  const snapshot = histogram.snapshot('resolver_http');
  assert.equal(snapshot.count, 4);
  assert.equal(snapshot.min, 9996);
  assert.equal(snapshot.max, 9999);
});

test('snapshots are independent immutable copies across static series', () => {
  const histogram = createLatencyHistogram();
  histogram.observe('resolver_direct', 7);
  const snapshot = histogram.snapshotAll();
  assert.equal(snapshot.resolver_direct.count, 1);
  assert.equal(snapshot.shadow_total.count, 0);
  assert.throws(() => { snapshot.resolver_direct.count = 99; }, TypeError);
  assert.equal(histogram.snapshot('resolver_direct').count, 1);
});

test('unknown series, invalid durations and unsafe configuration are rejected', () => {
  const histogram = createLatencyHistogram();
  assert.throws(() => histogram.observe('dynamic_provider_id', 1));
  assert.throws(() => histogram.observe('source_http', -1));
  assert.throws(() => histogram.observe('source_http', Infinity));
  assert.throws(() => createLatencyHistogram({ maxSamples: 0 }));
});
