'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ARCHITECTURE_FAMILIES,
  createArchitectureDetails,
  createArchitectureSummary,
  deriveArchitectureFamily,
  detectArchitectureSignals,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiArchitecture');
const { scanKodiTaxonomy } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner');
const {
  formatKodiArchitectureJson,
  formatKodiArchitectureText,
  parseKodiTaxonomyArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const familyFor = (text, classifications) => deriveArchitectureFamily({
  classifications,
  signals: detectArchitectureSignals(text),
});

test('bounded static signals cover manifests, sessions, headers, JSON, iframe and media', () => {
  const signals = detectArchitectureSignals(`
    manifest = '#EXTM3U\\n#EXTINF:10,\\n#EXT-X-BYTERANGE:100@0'
    open('local.m3u8', 'w').write(manifest)
    response.headers.get('Set-Cookie'); headers={'Cookie': cookie}
    headers['Referer'] = page; headers['Origin'] = origin
    data = json.loads(body); iframe_src = extract_iframe(body)
    hls = 'video.m3u8'; file = 'video.mp4'
  `);
  for (const expected of ['manifest_extm3u', 'manifest_extinf', 'manifest_byterange',
    'writes_m3u8', 'consumes_set_cookie', 'forwards_cookie', 'uses_referer',
    'uses_origin', 'json_endpoint', 'extracts_iframe', 'direct_m3u8', 'direct_mp4']) {
    assert.ok(signals.includes(expected), expected);
  }
});

test('architecture families derive from observable features with conservative precedence', () => {
  const cases = [
    [`manifest='#EXTM3U\\n#EXTINF:1,'`, ['direct_hls'], 'MANIFEST_SYNTHESIS'],
    ['jsunpack(payload)', ['javascript_transform', 'direct_hls'], 'JAVASCRIPT_TRANSFORM'],
    [`headers={'Cookie': value}`, ['cookie_session', 'direct_hls'], 'SESSION_HTTP'],
    [`url='video.m3u8'; headers={'Referer': page}`, ['direct_hls', 'header_bound'],
      'HLS_WITH_HEADERS'],
    ['response.json()', ['json_api', 'direct_http'], 'HTTP_API'],
    ['iframe_src = extract_iframe(html)', ['iframe_http', 'static_html'],
      'DECLARATIVE_HTML'],
    [`url='video.mp4'`, ['direct_http'], 'DIRECT_MEDIA'],
    ['plain module', ['unknown'], 'UNKNOWN'],
  ];
  for (const [source, classifications, expected] of cases) {
    assert.equal(familyFor(source, classifications), expected);
  }
});

test('architecture scanning is opt-in, bounded and aggregate output is redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-architecture-'));
  const servers = path.join(root, 'addon', 'servers');
  fs.mkdirSync(servers, { recursive: true });
  const fixtures = {
    manifest: `manifest='#EXTM3U\\n#EXTINF:1,'`,
    headers: `url='movie.m3u8?token=SECRET'; headers={'Referer':'https://private.example'}`,
    api: 'data = response.json()',
    html: 'iframe_src = extract_iframe(html)',
    direct: `url='movie.mp4?token=SECRET'`,
    session: `cookie = response.headers.get('Set-Cookie')`,
    javascript: 'jsunpack(payload)',
    unknown: 'plain harmless module',
  };
  for (const [name, source] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(servers, `${name}.py`), source);
  }
  try {
    const plain = scanKodiTaxonomy({ roots: [root] });
    assert.equal(Object.hasOwn(plain.records[0], 'architectureFamily'), false);
    const taxonomy = scanKodiTaxonomy({ roots: [root], architecture: true });
    const summary = createArchitectureSummary(taxonomy.records);
    assert.equal(summary.total, Object.keys(fixtures).length);
    for (const family of ARCHITECTURE_FAMILIES) assert.equal(summary[family], 1);
    for (const output of [formatKodiArchitectureJson(taxonomy, summary),
      formatKodiArchitectureText(taxonomy, summary)]) {
      assert.doesNotMatch(output, /SECRET|private\.example|https?:\/\//i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('architecture CLI is explicit and mutually exclusive with coverage', () => {
  const parsed = parseKodiTaxonomyArgs(
    ['--balandro-path', 'C:/tmp/balandro', '--architecture', '--json']);
  assert.deepEqual(parsed, { ok: true, json: true, coverage: false, architecture: true,
    roots: ['C:/tmp/balandro'] });
  assert.equal(parseKodiTaxonomyArgs(
    ['--balandro-path', 'C:/tmp/balandro', '--architecture', '--coverage']).ok, false);
  assert.equal(parseKodiTaxonomyArgs(
    ['--balandro-path', 'C:/tmp/balandro', '--architecture', '--architecture']).ok, false);
  assert.equal(parseKodiTaxonomyArgs(
    ['--balandro-path', 'C:/tmp/balandro', '--architecture-details']).ok, false);
  assert.deepEqual(parseKodiTaxonomyArgs(['--balandro-path', 'C:/tmp/balandro',
    '--architecture', '--architecture-details']), {
    ok: true, json: false, coverage: false, architecture: true,
    architectureDetails: true, roots: ['C:/tmp/balandro'],
  });
});

test('architecture details deduplicate and sort server IDs within every family', () => {
  const records = [
    { kind: 'server', id: 'zeta', architectureFamily: 'UNKNOWN' },
    { kind: 'server', id: 'alpha', architectureFamily: 'UNKNOWN' },
    { kind: 'server', id: 'alpha', architectureFamily: 'UNKNOWN' },
    { kind: 'server', id: 'html_b', architectureFamily: 'DECLARATIVE_HTML' },
    { kind: 'server', id: 'html_a', architectureFamily: 'DECLARATIVE_HTML' },
    { kind: 'channel', id: 'ignored', architectureFamily: 'UNKNOWN' },
  ];
  const details = createArchitectureDetails(records);
  assert.deepEqual(details.serversByArchitecture.UNKNOWN, ['alpha', 'zeta']);
  assert.deepEqual(details.serversByArchitecture.DECLARATIVE_HTML, ['html_a', 'html_b']);
  assert.equal(details.counts.UNKNOWN, 3);
  assert.equal(details.counts.DECLARATIVE_HTML, 2);
  assert.equal(details.counts.total, 5);

  const taxonomy = { servers: { total: 5, active: 5 }, channels: { total: 1 },
    skipped: 0 };
  const summary = createArchitectureSummary(records);
  const text = formatKodiArchitectureText(taxonomy, summary, details);
  assert.match(text, /DECLARATIVE_HTML=2\nhtml_a\nhtml_b/);
  assert.match(text, /UNKNOWN=3\nalpha\nzeta$/);
  const json = JSON.parse(formatKodiArchitectureJson(taxonomy, summary, details));
  assert.deepEqual(json.architecture, details);
});

test('architecture diagnostics contain no execution, dynamic loading or network primitives', () => {
  for (const modulePath of [
    '../src/modules/streams/resolverV2/diagnostics/kodiArchitecture',
    '../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner',
  ]) {
    const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
    assert.doesNotMatch(source,
      /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|dynamic\s+import|new Function|\beval\s*\(/i);
  }
});
