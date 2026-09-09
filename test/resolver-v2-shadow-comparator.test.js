'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShadowLegacyComparator } =
  require('../src/modules/streams/resolverV2/observability/shadowLegacyComparator');

const comparator = createShadowLegacyComparator();
const selected = (overrides = {}) => ({
  protocol: 'hls', qualityTier: '1080p', languageTier: 'latino',
  validated: true, resolverStrategy: 'direct', ...overrides,
});
const legacy = (overrides = {}) => ({
  strategy: 'browser', quality: '720p', audioLanguage: 'en', subtitleLanguage: null,
  ...overrides,
});
const compare = (shadowOverrides = {}, legacyOverrides = {}) => comparator.compare({
  shadow: { status: 'success', selected: selected(), ...shadowOverrides },
  legacy: legacy(legacyOverrides),
});

test('wouldAvoidBrowser requires ready validated HLS and confirmed browser use', () => {
  assert.equal(compare().wouldAvoidBrowser, true);
  assert.equal(compare({ selected: selected({ validated: false }) }).wouldAvoidBrowser, false);
  assert.equal(compare({ status: 'no_streams', selected: null }).wouldAvoidBrowser, false);
  assert.equal(compare({}, { strategy: 'direct' }).wouldAvoidBrowser, false);
  assert.equal(compare({}, { strategy: undefined }).wouldAvoidBrowser, 'unknown');
});

test('quality comparison prioritizes language before quality', () => {
  assert.equal(compare().qualityComparison, 'shadow_better');
  assert.equal(compare({ selected: selected({ languageTier: 'vo', qualityTier: '1080p' }) },
    { audioLanguage: 'es-419', quality: '480p' }).qualityComparison, 'legacy_better');
  assert.equal(compare({ selected: selected({ languageTier: 'vo', qualityTier: '720p' }) },
    { audioLanguage: 'en', quality: '720p' }).qualityComparison, 'equivalent');
  assert.equal(compare({}, { audioLanguage: null }).qualityComparison, 'unknown');
});

test('comparison summary is safe and does not retain candidate or legacy payloads', () => {
  const summary = comparator.compare({
    shadow: { status: 'success', selected: {
      ...selected(), url: 'https://hidden.test/a.m3u8?token=x', headers: { cookie: 'x' },
    } },
    legacy: { ...legacy(), url: 'https://legacy.test/a.m3u8?token=y' },
  });
  assert.doesNotMatch(JSON.stringify(summary),
    /https?:|authorization|cookie|token=|title|contentId|tmdbId|headers|referer|origin/i);
});
