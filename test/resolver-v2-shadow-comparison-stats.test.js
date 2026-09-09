'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShadowComparisonStats } =
  require('../src/modules/streams/resolverV2/observability/shadowComparisonStats');

test('comparison stats count static outcomes and derive correct denominators', () => {
  const stats = createShadowComparisonStats();
  assert.equal(stats.snapshot().browserAvoidancePotential, null);
  stats.record({ shadowReady: true, shadowStatus: 'success', legacyReady: true,
    legacyBrowserUsed: true, wouldAvoidBrowser: true, qualityComparison: 'shadow_better' });
  stats.record({ shadowReady: false, shadowStatus: 'no_streams', legacyReady: true,
    legacyBrowserUsed: true, wouldAvoidBrowser: false, qualityComparison: 'legacy_better' });
  stats.record({ shadowReady: false, shadowStatus: 'timeout', legacyReady: false,
    legacyBrowserUsed: 'unknown', wouldAvoidBrowser: 'unknown', qualityComparison: 'unknown' });
  const snapshot = stats.snapshot();
  assert.equal(snapshot.comparisons, 3);
  assert.equal(snapshot.shadow_ready, 1);
  assert.equal(snapshot.shadow_empty, 1);
  assert.equal(snapshot.shadow_timeout, 1);
  assert.equal(snapshot.browserFallbackRate, 1);
  assert.equal(snapshot.browserAvoidanceRate, 0.5);
  assert.equal(snapshot.browserAvoidancePotential, 0.5);
  assert.equal(snapshot.shadowReadyRate, 1 / 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:|provider|resolver|content|token/i);
});

test('unknown browser state is excluded from browser fallback denominator', () => {
  const stats = createShadowComparisonStats();
  stats.record({ shadowReady: false, shadowStatus: 'failed', legacyReady: true,
    legacyBrowserUsed: 'unknown', wouldAvoidBrowser: 'unknown', qualityComparison: 'unknown' });
  assert.equal(stats.snapshot().browserFallbackRate, null);
  assert.equal(stats.snapshot().browserAvoidanceRate, null);
  assert.equal(stats.snapshot().legacy_browser_unknown, 1);
});
