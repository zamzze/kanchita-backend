'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { detectRegexUses, scanChannelRegexGap } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiChannelRegexGap');
const { formatKodiChannelRegexGapJson, formatKodiChannelRegexGapText,
  parseKodiTaxonomyArgs } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const withChannels = (files, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-channel-regex-gap-'));
  const channels = path.join(root, 'channels');
  fs.mkdirSync(channels);
  fs.writeFileSync(path.join(channels, '__init__.py'), '');
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(channels, name), source);
  }
  return Promise.resolve(callback(root)).finally(() =>
    fs.rmSync(root, { recursive: true, force: true }));
};

const categories = (source) => detectRegexUses(source).map(({ category }) => category);

test('simple href and data-id captures are attribute extraction', () => {
  assert.deepEqual(categories(`re.search(r'href="([^"]+)"', html)`),
    ['REGEX_ATTRIBUTE_EXTRACTION']);
  assert.deepEqual(categories(`re.search(r'data-id="([^"]+)"', html)`),
    ['REGEX_ATTRIBUTE_EXTRACTION']);
});

test('simple non-HTML capture uses safe single capture', () => {
  assert.deepEqual(categories(`re.search(r'identifier:([0-9]+)', payload)`),
    ['REGEX_SIMPLE_CAPTURE']);
});

test('embedded script text is separated from attribute extraction', () => {
  assert.deepEqual(categories(`script_text = page.data\nre.search(r'token=([^;]+)', script_text)`),
    ['REGEX_TEXT_CAPTURE']);
});

test('multiple coordinated captures are detected', () => {
  assert.deepEqual(categories(`re.findall(r'([0-9]+)-([a-z]+)', payload)`),
    ['REGEX_MULTI_CAPTURE']);
});

test('rewrite, decode and JavaScript coupling have conservative precedence', () => {
  assert.deepEqual(categories(`value = re.sub(r'[^a-z]', '', payload)`), ['REGEX_REWRITE']);
  assert.deepEqual(categories(`value = re.search(r'([^;]+)', payload)\nbase64.b64decode(value)`),
    ['REGEX_DECODE_CHAIN']);
  assert.deepEqual(categories(`value = re.search(r'([^;]+)', payload)\njsunpack(value)`),
    ['REGEX_JAVASCRIPT_COUPLED']);
});

test('dynamic and insufficiently described regex uses remain explicit', () => {
  assert.deepEqual(categories(`re.search('prefix-' + suffix, payload)`),
    ['REGEX_DYNAMIC_PATTERN']);
  assert.deepEqual(categories(`re.search(pattern, payload)`), ['UNKNOWN_REGEX_USE']);
  assert.deepEqual(categories(`re.search(r'literal', payload)`), ['UNKNOWN_REGEX_USE']);
});

test('scanner uses only AG.2 html-regex-gap population and partitions reduction', async () => {
  await withChannels({
    'attribute.py': `page=httptools.downloadpage(url)\nre.search(r'href="([^"]+)"', page.data)\nre.search(r'src="([^"]+)"', page.data)\nre.search(r'data-id="([^"]+)"', page.data)`,
    'text.py': `page=httptools.downloadpage(url)\nscript_text=page.data\nre.search(r'token=([^;]+)', script_text)\nre.search(r'value=([^;]+)', script_text)\nre.search(r'name=([^;]+)', script_text)`,
    'plain.py': `page=httptools.downloadpage(url)`,
  }, (root) => {
    const result = scanChannelRegexGap({ root });
    assert.equal(result.population.currentGapChannels, 2);
    assert.equal(result.hypotheticalReduction.existingPrimitives, 1);
    assert.equal(result.hypotheticalReduction.boundedTextCapture, 1);
    assert.equal(result.records.some(({ channel }) => channel === 'plain'), false);
  });
});

test('proxy overlap, direct MP4 role and UNKNOWN channels remain separate', async () => {
  await withChannels({
    'proxyregex.py': `proxy='regional'\npage=httptools.downloadpage(url)\nre.search(r'([0-9]+)', page.data)\nre.search(r'([a-z]+)', page.data)\nre.search(r'([^;]+)', page.data)`,
    'media.py': `page=httptools.downloadpage(url)\nmedia='video.mp4'\nplaylist='video.m3u8'`,
    'unknown.py': 'CONSTANT=1',
  }, (root) => {
    const result = scanChannelRegexGap({ root });
    assert.deepEqual(result.proxyOrGeoOverlap, ['proxyregex']);
    assert.deepEqual(result.directMp4, [{ channel: 'media', role: 'SOURCE_ALONGSIDE_HLS',
      observedSignals: ['also_hls'] }]);
    assert.deepEqual(result.unknownChannels, ['unknown']);
  });
});

test('candidate components expose bounded required and forbidden features', async () => {
  await withChannels({
    'simple.py': `page=httptools.downloadpage(url)\nre.search(r'([0-9]+)', page.data)\nre.search(r'([a-z]+)', page.data)\nre.search(r'([^;]+)', page.data)`,
  }, (root) => {
    const result = scanChannelRegexGap({ root });
    const component = result.candidateComponents.find(({ id }) =>
      id === 'safe_regex_single_capture');
    assert.deepEqual(component.affectedChannels, ['simple']);
    assert.ok(component.requiredFeatures.includes('bounded_input'));
    assert.ok(component.forbiddenFeatures.includes('dynamic_patterns'));
    assert.ok(component.forbiddenFeatures.includes('execution'));
  });
});

test('output is deterministic and never leaks regex, source or sensitive URLs', async () => {
  await withChannels({
    'redacted.py': `page=httptools.downloadpage('https://private.example/?token=SECRET')\nre.search(r'private-one-([0-9]+)', page.data)\nre.search(r'private-two-([a-z]+)', page.data)\nre.search(r'private-three-([^;]+)', page.data)`,
  }, (root) => {
    const first = scanChannelRegexGap({ root });
    const second = scanChannelRegexGap({ root });
    assert.deepEqual(first, second);
    const json = formatKodiChannelRegexGapJson(first);
    const text = formatKodiChannelRegexGapText(first);
    assert.deepEqual(JSON.parse(json).channelRegexGap, first);
    for (const output of [json, text]) {
      assert.doesNotMatch(output, /private-one|private-two|private-three|SECRET|https?:\/\//i);
    }
  });
});

test('channel regex CLI is opt-in, requires coverage and leaves old CLI unchanged', () => {
  const root = ['--balandro-path', 'C:/fixture'];
  assert.equal(parseKodiTaxonomyArgs([...root, '--channel-regex-gap']).ok, false);
  assert.deepEqual(parseKodiTaxonomyArgs([...root, '--channel-coverage-v2',
    '--channel-regex-gap', '--json']), {
    ok: true, json: true, coverage: false, channelCoverageV2: true,
    channelRegexGap: true, roots: ['C:/fixture'],
  });
  assert.deepEqual(parseKodiTaxonomyArgs(root), {
    ok: true, json: false, coverage: false, roots: ['C:/fixture'],
  });
});

test('implementation is static and contains no execution or network primitives', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiChannelRegexGap'), 'utf8');
  assert.doesNotMatch(source,
    /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|dynamic\s+import|new Function|\beval\s*\(/i);
});
