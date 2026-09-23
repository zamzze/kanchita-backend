'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createManifest } = require(
  '../src/modules/streams/resolverV2/diagnostics/providerMigrationManifest');
const { createProfile, evaluateBundle, createMinimumCapabilityBundles } = require(
  '../src/modules/streams/resolverV2/diagnostics/minimumCapabilityBundles');

const record = (id, missingCapabilitySet, blockers = [], overrides = {}) => ({
  id, kind: 'server', files: [`servers/${id}.py`], migrationFamily: 'HTML_EMBED',
  migrationStatus: missingCapabilitySet.length ? 'NEEDS_GENERIC_CAPABILITY'
    : 'CONFIG_WITH_CURRENT_RUNTIME',
  missingCapabilities: missingCapabilitySet, excludedBlockers: blockers,
  identitySignals: [], ...overrides,
});
const byId = (result, id) => result.profiles.find((item) => item.id === id);

test('isolated regex never unlocks a module also needing MP4', () => {
  const profile = createProfile(record('regexmp4', ['safe_regex_single_capture', 'direct_mp4']));
  assert.equal(profile.minimumBundleSize, 5);
  assert.equal(evaluateBundle([profile], ['safe_regex_single_capture']).fullUnlockDelta, 0);
});

test('MP4 is four independent platform gaps', () => {
  const profile = createProfile(record('mp4', ['direct_mp4']));
  assert.deepEqual(profile.platformGaps, ['direct_mp4_resolver', 'mp4_api_contract',
    'mp4_lifecycle', 'mp4_primary_acceptance']);
  assert.equal(profile.minimumBundleSize, 4);
  assert.equal(evaluateBundle([profile], ['direct_mp4_resolver']).fullUnlockDelta, 0);
});

test('regex plus MP4 stays a five-part minimum bundle', () => {
  const profile = createProfile(record('combined', ['safe_regex_single_capture', 'direct_mp4']));
  assert.equal(profile.missingCapabilitySet.length, 5);
  assert.equal(evaluateBundle([profile], profile.missingCapabilitySet).fullUnlockDelta, 1);
});

test('JSON array iteration is separate from scalar chaining and multi-value regex', () => {
  const profile = createProfile(record('array', ['array_iteration',
    'scalar_capture_chaining']));
  assert.equal(profile.minimumBundleSize, 2);
  assert.equal(profile.missingCapabilitySet.includes('multi_value_extract'), false);
  assert.equal(evaluateBundle([profile], ['array_iteration']).fullUnlockDelta, 0);
});

test('excluded blocker never becomes a full unlock', () => {
  const profile = createProfile(record('protected', ['safe_regex_single_capture'],
    ['javascript']));
  assert.equal(profile.potentiallyMigratable, false);
  assert.equal(profile.minimumBundleSize, null);
  assert.equal(evaluateBundle([profile], ['safe_regex_single_capture']).fullUnlockDelta, 0);
});

test('bundle ordering is deterministic: delta, size, affected, name', () => {
  const manifest = [record('a', ['array_iteration']),
    record('b', ['array_iteration', 'scalar_capture_chaining']),
    record('c', ['safe_regex_single_capture'])];
  const first = createMinimumCapabilityBundles({ manifest });
  const second = createMinimumCapabilityBundles({ manifest: [...manifest].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.bundles[0].fullUnlockDelta >= first.bundles[1].fullUnlockDelta, true);
});

test('Python/JSON siblings remain one module through AJ.1 manifest', () => {
  const files = [{ kind: 'server', name: 'same.py', text: 'def resolve(url):\n return url' },
    { kind: 'server', name: 'same.json', text: '{"active":true}' }];
  const manifest = createManifest(files).manifest;
  const result = createMinimumCapabilityBundles({ manifest });
  assert.equal(result.profiles.length, 1);
});

test('manifest output cannot leak URLs, raw regexes, or source strings', () => {
  const manifest = [record('redacted', ['safe_regex_single_capture'])];
  const result = createMinimumCapabilityBundles({ manifest, sources: {
    'server:redacted': 'url="https://example.test/path?token=secret"\n' +
      'return scrapertools.find_single_match(data, "foo([^/]+)")',
  } });
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/|example\.test|token=secret|foo\(/);
});

test('list discovery remains blocked without exact-item evidence', () => {
  const profile = createProfile(record('catalog', ['array_iteration'], [], {
    kind: 'channel', migrationStatus: 'MANUAL_REVIEW',
    files: ['channels/catalog.py'], identitySignals: [],
  }), 'for vid in data["list"]:');
  assert.equal(profile.excludedBlockers.includes('exact_item_not_proven'), true);
  assert.equal(evaluateBundle([profile], ['array_iteration']).fullUnlockDelta, 0);
});
