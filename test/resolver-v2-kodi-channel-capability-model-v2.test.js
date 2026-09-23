'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createChannelCapabilityModelV2 } = require(
  '../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityModelV2');
const { createChannelCapabilityPayoff } = require(
  '../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityPayoff');

const channel = (id, gaps = ['html_regex_transform']) => ({ channel: id,
  missingCapabilities: gaps });
const record = (id, category) => ({ channel: id, category });
const model = (entries) => createChannelCapabilityModelV2({
  coverage: { channels: entries.map(({ id, gaps }) => channel(id, gaps)) },
  regexGap: { records: entries.flatMap(({ id, categories = ['REGEX_TEXT_CAPTURE'] }) =>
    categories.map((category) => record(id, category))) },
  channelSources: Object.fromEntries(entries.map(({ id, source }) => [id, source])),
});
const profile = (result, id) => result.channels.find(({ channel: name }) => name === id);
const payoff = (result, capabilities) => result.payoff.find((entry) =>
  entry.capabilities.join('+') === [...capabilities].sort().join('+'));

test('literal response body capture is in the AH.1 baseline', () => {
  const result = model([{ id: 'literal', source:
    '# embedded text\nscrapertools.find_single_match(data, "START(.*?)END")' }]);
  assert.deepEqual(profile(result, 'literal').requiredCapabilities,
    ['literal_response_body_capture']);
  assert.deepEqual(profile(result, 'literal').missingCapabilities, []);
  assert.deepEqual(result.currentlyRepresentableChannels, ['literal']);
});

test('scalar chaining is distinct from response body capture', () => {
  const result = model([{ id: 'scalar', source:
    '# embedded text\nscrapertools.find_single_match(block, "START(.*?)END")' }]);
  assert.deepEqual(profile(result, 'scalar').missingCapabilities, ['scalar_capture_chaining']);
});

test('global repetition is separate from scalar and multi value extraction', () => {
  const result = model([{ id: 'global', source:
    '# embedded text\nscrapertools.find_multiple_matches(data, "A(.*?)Z")' }]);
  assert.ok(profile(result, 'global').missingCapabilities.includes('repeated_capture'));
  assert.equal(profile(result, 'global').missingCapabilities.includes('multi_value_extract'), false);
});

test('a regex pattern is never implicitly literal capture', () => {
  const result = model([{ id: 'regex', source:
    '# embedded text\nscrapertools.find_single_match(data, "A\\s*(.*?)Z")' }]);
  assert.deepEqual(profile(result, 'regex').missingCapabilities,
    ['safe_regex_single_capture']);
});

test('multiple capture groups need coordinated values and multi regex semantics', () => {
  const result = model([{ id: 'multi', categories: ['REGEX_MULTI_CAPTURE'], source:
    'scrapertools.find_single_match(data, "A(.*?)B(.*?)Z")' }]);
  assert.deepEqual(profile(result, 'multi').missingCapabilities,
    ['multi_value_extract', 'safe_regex_multi_capture']);
  assert.equal(profile(result, 'multi').missingCapabilities.includes('repeated_capture'), false);
});

test('decode, text recode and rewrite are separate requirements', () => {
  const result = model([
    { id: 'decode', categories: ['REGEX_SIMPLE_CAPTURE'],
      source: 'data = data.decode("utf8")' },
    { id: 'recode', categories: ['REGEX_SIMPLE_CAPTURE'],
      source: 'data = data.decode("latin1").encode("utf8")' },
    { id: 'rewrite', categories: ['REGEX_REWRITE'], source:
      'value = re.sub("a", "b", value)' },
  ]);
  assert.deepEqual(profile(result, 'decode').missingCapabilities, ['static_decode']);
  assert.deepEqual(profile(result, 'recode').missingCapabilities, ['text_recode']);
  assert.deepEqual(profile(result, 'rewrite').missingCapabilities, ['bounded_rewrite']);
});

test('dynamic regex and source blockers remain explicit', () => {
  const result = model([{ id: 'dynamic', categories: ['REGEX_DYNAMIC_PATTERN'],
    gaps: ['html_regex_transform', 'persistent_session', 'proxy_or_geo'],
    source: 'scrapertools.find_single_match(data, "A" + token)' }]);
  assert.deepEqual(profile(result, 'dynamic').excludedBlockers,
    ['dynamic_regex', 'persistent_session', 'proxy_or_geo']);
  assert.equal(result.currentlyRepresentableChannels.includes('dynamic'), false);
});

test('ciberdocumentales cannot be unlocked by literal baseline alone', () => {
  const result = model([{ id: 'ciberdocumentales', source:
    '# embedded text\nblock = scrapertools.find_single_match(data, "A(.*?)Z")\n' +
    'items = scrapertools.find_multiple_matches(block, "B(.*?)Q")\n' +
    'data = data.decode("latin1").encode("utf8")' }]);
  const item = profile(result, 'ciberdocumentales');
  assert.ok(item.missingCapabilities.includes('scalar_capture_chaining'));
  assert.ok(item.missingCapabilities.includes('repeated_capture'));
  assert.ok(item.missingCapabilities.includes('text_recode'));
  assert.equal(result.currentlyRepresentableChannels.includes('ciberdocumentales'), false);
});

test('payoff is incremental to AH.1 and excludes unresolved blockers', () => {
  const result = model([
    { id: 'ready', source: '# embedded text\nscrapertools.find_single_match(data, "A(.*?)Z")' },
    { id: 'scalar', source: '# embedded text\nscrapertools.find_single_match(block, "A(.*?)Z")' },
    { id: 'combined', source: '# embedded text\n' +
      'scrapertools.find_multiple_matches(block, "A(.*?)Z")' },
    { id: 'blocked', gaps: ['html_regex_transform', 'persistent_session'],
      source: '# embedded text\nscrapertools.find_single_match(block, "A(.*?)Z")' },
  ]);
  assert.deepEqual(payoff(result, ['scalar_capture_chaining']).fullyUnlockedChannels, ['scalar']);
  assert.equal(payoff(result, ['scalar_capture_chaining']).fullUnlockDelta, 1);
  assert.equal(payoff(result, ['scalar_capture_chaining']).partialReductionDelta, 2);
  assert.deepEqual(payoff(result, ['scalar_capture_chaining', 'repeated_capture'])
    .fullyUnlockedChannels, ['combined', 'scalar']);
  assert.equal(result.payoff.length, 10);
});

test('ordering is deterministic and outputs contain no source or regex text', () => {
  const entries = [{ id: 'z', source:
    '# embedded text\nscrapertools.find_single_match(data, "PRIVATE_A(.*?)PRIVATE_Z")' },
  { id: 'a', source: '# embedded text\nscrapertools.find_single_match(block, "A(.*?)Z")' }];
  const first = model(entries);
  assert.deepEqual(first, model(entries));
  assert.deepEqual(first.channels.map(({ channel: id }) => id), ['a', 'z']);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_A|PRIVATE_Z|https?:\/\/|Authorization/);
});

test('AG.4 reports retain their original model when AG.5 runs', () => {
  const coverage = { channels: [channel('one')] };
  const regexGap = { records: [record('one', 'REGEX_TEXT_CAPTURE')], directMp4: [] };
  const before = createChannelCapabilityPayoff({ coverage, regexGap });
  createChannelCapabilityModelV2({ coverage, regexGap,
    channelSources: { one: '# embedded text\nscrapertools.find_single_match(data, "A(.*?)Z")' } });
  assert.deepEqual(createChannelCapabilityPayoff({ coverage, regexGap }), before);
});

test('diagnostic reads static files only and cannot execute Python or use network', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityModelV2'), 'utf8');
  assert.doesNotMatch(source, /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|puppeteer|new Function|\beval\s*\(/i);
});
