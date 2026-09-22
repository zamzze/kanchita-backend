'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createChannelCapabilityPayoff } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityPayoff');
const { formatKodiChannelCapabilityPayoffJson, formatKodiChannelCapabilityPayoffText,
  parseKodiTaxonomyArgs } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const channel = (id, missingCapabilities = [], pattern = 'HTML_CATALOG') => ({
  channel: id, pattern, assessment: missingCapabilities.length
    ? 'NEEDS_SMALL_GENERIC_COMPONENT' : 'MAPPABLE_WITH_CURRENT_COMPONENTS',
  missingCapabilities, sourceSignals: [],
});
const record = (id, category) => ({ channel: id, category, count: 1,
  observedSignals: [], possibleCurrentPrimitive: null, missingPrimitive: null,
  reason: 'SYNTHETIC' });
const fixture = () => ({
  coverage: { population: { channels: 8 }, channels: [
    channel('already'),
    channel('attribute', ['html_regex_transform']),
    channel('combo', ['html_regex_transform']),
    channel('dynamic', ['html_regex_transform']),
    channel('excluded', ['html_regex_transform', 'proxy_or_geo']),
    channel('mp4_download', ['direct_mp4']),
    channel('mp4_fallback', ['direct_mp4']),
    channel('single', ['html_regex_transform']),
  ] },
  regexGap: { records: [
    record('attribute', 'REGEX_ATTRIBUTE_EXTRACTION'),
    record('combo', 'REGEX_TEXT_CAPTURE'),
    record('combo', 'REGEX_MULTI_CAPTURE'),
    record('dynamic', 'REGEX_DYNAMIC_PATTERN'),
    record('excluded', 'REGEX_TEXT_CAPTURE'),
    record('single', 'REGEX_SIMPLE_CAPTURE'),
  ], directMp4: [
    { channel: 'mp4_download', role: 'DOWNLOAD_LINK', observedSignals: [] },
    { channel: 'mp4_fallback', role: 'FALLBACK', observedSignals: [] },
  ] },
});
const resultFor = (payoff, capabilities) => payoff.candidateSets.find((item) =>
  item.capabilities.join('+') === [...capabilities].sort().join('+'));

test('one capability fully unlocks a complete channel', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  assert.deepEqual(resultFor(payoff, ['safe_regex_single_capture']).channels.fullyUnblocked,
    ['single']);
});

test('a capability can partially reduce a channel without counting it as unlocked', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const bounded = resultFor(payoff, ['bounded_text_capture']);
  assert.ok(bounded.channels.partiallyReduced.includes('combo'));
  assert.equal(bounded.channels.fullyUnblocked.includes('combo'), false);
});

test('excluded blocker prevents full unlock', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const bounded = resultFor(payoff, ['bounded_text_capture']);
  assert.ok(bounded.channels.partiallyReduced.includes('excluded'));
  assert.ok(bounded.channels.blockedByExcludedCapabilities.includes('excluded'));
  assert.equal(bounded.channels.fullyUnblocked.includes('excluded'), false);
});

test('combination unlocks when individual capabilities do not', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  assert.equal(resultFor(payoff, ['bounded_text_capture']).fullyUnblocked, 0);
  assert.equal(resultFor(payoff, ['multi_value_extract']).fullyUnblocked, 0);
  assert.deepEqual(resultFor(payoff,
    ['bounded_text_capture', 'multi_value_extract']).channels.fullyUnblocked, ['combo']);
});

test('marginal payoff compares a set against the exact set without one capability', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const marginal = payoff.marginalPayoff.find((item) =>
    item.capabilities.join('+') === 'bounded_text_capture+multi_value_extract' &&
    item.addedCapability === 'multi_value_extract');
  assert.equal(marginal.additionalFullyUnblocked, 1);
  assert.deepEqual(marginal.channels, ['combo']);
});

test('direct MP4 download and fallback semantics never falsely unlock playback architecture', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const direct = resultFor(payoff, ['direct_mp4']);
  assert.ok(direct.channels.partiallyReduced.includes('mp4_download'));
  assert.ok(direct.channels.partiallyReduced.includes('mp4_fallback'));
  assert.equal(direct.channels.fullyUnblocked.includes('mp4_download'), false);
  assert.equal(direct.channels.fullyUnblocked.includes('mp4_fallback'), false);
  assert.ok(payoff.directMp4Impact.every(({ outcome }) => outcome === 'PARTIALLY_REDUCED'));
  assert.ok(payoff.directMp4Impact.every(({ excludedBlockers }) =>
    excludedBlockers.includes('non_primary_mp4')));
});

test('existing HTML attribute primitive is not counted as a new capability', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const profile = payoff.channels.find(({ channel: id }) => id === 'attribute');
  assert.deepEqual(profile.requiredNewCapabilities, []);
  assert.equal(payoff.candidateSets.some(({ channels }) =>
    channels.fullyUnblocked.includes('attribute')), false);
});

test('dynamic regex remains explicitly excluded', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const profile = payoff.channels.find(({ channel: id }) => id === 'dynamic');
  assert.deepEqual(profile.excludedBlockers, ['dynamic_regex_pattern']);
  assert.equal(profile.unlockable, false);
});

test('candidate and channel ordering are deterministic', () => {
  const first = createChannelCapabilityPayoff(fixture());
  const second = createChannelCapabilityPayoff(fixture());
  assert.deepEqual(first, second);
  assert.deepEqual(first.channels.map(({ channel: id }) => id),
    ['already', 'attribute', 'combo', 'dynamic', 'excluded', 'mp4_download', 'mp4_fallback',
      'single']);
  assert.deepEqual([...first.candidateSets].sort((left, right) =>
    right.fullyUnblocked - left.fullyUnblocked ||
    left.capabilities.length - right.capabilities.length ||
    left.capabilities.join('+').localeCompare(right.capabilities.join('+'))),
  first.candidateSets);
});

test('JSON and text output are deterministic and redact source details', () => {
  const payoff = createChannelCapabilityPayoff(fixture());
  const json = formatKodiChannelCapabilityPayoffJson(payoff);
  const text = formatKodiChannelCapabilityPayoffText(payoff);
  assert.deepEqual(JSON.parse(json).channelCapabilityPayoff, payoff);
  for (const output of [json, text]) {
    assert.doesNotMatch(output, /https?:\/\/|SECRET|Authorization|Cookie|\(\?P?</i);
  }
});

test('capability payoff CLI is opt-in, standalone and leaves old behavior unchanged', () => {
  const root = ['--balandro-path', 'C:/fixture'];
  assert.deepEqual(parseKodiTaxonomyArgs([...root, '--channel-capability-payoff', '--json']), {
    ok: true, json: true, coverage: false, channelCapabilityPayoff: true,
    roots: ['C:/fixture'],
  });
  assert.equal(parseKodiTaxonomyArgs([...root, '--channel-capability-payoff',
    '--channel-coverage-v2']).ok, false);
  assert.deepEqual(parseKodiTaxonomyArgs(root), {
    ok: true, json: false, coverage: false, roots: ['C:/fixture'],
  });
});

test('payoff module has no runtime, transport, execution or browser coupling', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityPayoff'), 'utf8');
  assert.doesNotMatch(source,
    /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|puppeteer|dynamic\s+import|new Function|\beval\s*\(/i);
});
