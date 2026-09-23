'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createManifest, calculatePayoff } = require(
  '../src/modules/streams/resolverV2/diagnostics/providerMigrationManifest');

const moduleFile = (kind, name, text) => ({ kind, name, text });
const find = (result, kind, id) => result.manifest.find((item) =>
  item.kind === kind && item.id === id);

test('same server Python and JSON consolidate under one ID', () => {
  const result = createManifest([
    moduleFile('server', 'example.py', 'def get_video_url(url):\n return httptools.downloadpage(url)'),
    moduleFile('server', 'example.json', '{"active":true,"pattern":"example","media":".m3u8"}'),
  ]);
  assert.equal(result.summary.totalUniqueModules, 1);
  assert.deepEqual(result.manifest[0].files, ['servers/example.json', 'servers/example.py']);
});

test('one-line stub is manual review, not auto-convertible', () => {
  const record = find(createManifest([moduleFile('server', 'stub.py', 'pass')]),
    'server', 'stub');
  assert.equal(record.migrationStatus, 'MANUAL_REVIEW');
});

test('JSON-only descriptor and obfuscated one-line Python are never config-ready', () => {
  const result = createManifest([
    moduleFile('server', 'jsononly.json', '{"embed":"iframe","active":true,"note":"declarative metadata alone is not a resolver"}'),
    moduleFile('server', 'opaque.py', 'import base64; exec(base64.b64decode("fixture"))'),
  ]);
  assert.equal(find(result, 'server', 'jsononly').migrationStatus, 'MANUAL_REVIEW');
  assert.notEqual(find(result, 'server', 'opaque').migrationStatus,
    'CONFIG_WITH_CURRENT_RUNTIME');
});

test('exact item differs from list discovery and array iteration', () => {
  const exact = find(createManifest([moduleFile('channel', 'exact.py',
    'def findvideos(item):\n url = "/video/%s" % item.video_id\n data = httptools.downloadpage(url)\n return jsontools.load(data)["embed_url"]')]),
  'channel', 'exact');
  const list = find(createManifest([moduleFile('channel', 'list.py',
    'def list_all(item):\n data = jsontools.load(httptools.downloadpage("/user/videos").data)\n for vid in data["list"]:\n  item.url = vid["embed_url"]')]),
  'channel', 'list');
  assert.equal(exact.identitySignals.includes('exact_item_endpoint'), true);
  assert.equal(list.identitySignals.includes('exact_item_endpoint'), false);
  assert.equal(list.migrationFamily, 'ARRAY_CATALOG');
  assert.equal(list.missingCapabilities.includes('array_iteration'), true);
  assert.equal(list.migrationStatus, 'MANUAL_REVIEW');
});

test('channel and server with same ID stay distinct', () => {
  const result = createManifest([
    moduleFile('channel', 'same.py', 'def findvideos(item):\n return item.url'),
    moduleFile('server', 'same.py', 'def get_video_url(url):\n return url'),
  ]);
  assert.equal(result.summary.totalUniqueModules, 2);
  assert.deepEqual(result.summary.byKind, { channel: 1, server: 1 });
});

test('server delegation remains explicit', () => {
  const record = find(createManifest([moduleFile('channel', 'delegate.py',
    'def findvideos(item):\n return servertools.resolve_video_urls(item.url)')]),
  'channel', 'delegate');
  assert.equal(record.serverDelegation, true);
  assert.equal(record.migrationFamily, 'SERVER_DELEGATION');
});

test('protected, browser and session blockers prevent automatic migration', () => {
  for (const [id, source] of [['drm', 'widevine'], ['browser', 'selenium'],
    ['session', 'cookiejar']]) {
    const record = find(createManifest([moduleFile('server', `${id}.py`,
      `def get_video_url(url):\n data = httptools.downloadpage(url)\n return ${source}`)]),
    'server', id);
    assert.equal(record.migrationStatus, 'UNSUPPORTED');
    assert.equal(record.excludedBlockers.length > 0, true);
  }
});

test('ordering is deterministic independently of file order', () => {
  const files = [moduleFile('server', 'z.py', 'def resolve(url):\n return url'),
    moduleFile('channel', 'a.py', 'def list_all(item):\n return item.url')];
  assert.deepEqual(createManifest(files), createManifest([...files].reverse()));
});

test('manifest and summary contain no URLs, regex bodies or secrets', () => {
  const text = JSON.stringify(createManifest([moduleFile('server', 'redact.py',
    'def resolve(url):\n token="secret-token"\n url="https://example.test/path?token=secret"\n return re.search("full(regex)", url)')]));
  assert.doesNotMatch(text, /example\.test|secret-token|full\(regex\)|https:\/\//);
});

test('payoff separates fully unlocked from partial reduction', () => {
  const records = [{ migrationStatus: 'NEEDS_GENERIC_CAPABILITY',
    missingCapabilities: ['array_iteration'], excludedBlockers: [] },
  { migrationStatus: 'MANUAL_REVIEW', missingCapabilities: ['array_iteration'],
    excludedBlockers: [] },
  { migrationStatus: 'NEEDS_GENERIC_CAPABILITY', missingCapabilities: [
    'array_iteration', 'direct_mp4'], excludedBlockers: [] }];
  const item = calculatePayoff(records).find(({ capability }) => capability === 'array_iteration');
  assert.deepEqual(item, { capability: 'array_iteration', affectedModules: 3,
    fullUnlockDelta: 1, partialReductionDelta: 2 });
});
