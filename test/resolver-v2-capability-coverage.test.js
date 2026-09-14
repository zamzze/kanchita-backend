'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CAPABILITY_STATES,
  V2_CAPABILITY_MATRIX,
  createV2CapabilityMatrix,
} = require('../src/modules/streams/resolverV2/diagnostics/v2CapabilityMatrix');
const {
  classifyServerCoverage,
  createCoverageSummary,
  recommendNextCapability,
  signatureFor,
} = require('../src/modules/streams/resolverV2/diagnostics/capabilityCoverage');
const { scanKodiTaxonomy } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner');
const {
  createCoverageOutput,
  formatKodiCoverageJson,
  formatKodiCoverageText,
  parseKodiTaxonomyArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const entry = (classifications, overrides = {}) =>
  ({ kind: 'server', classifications, confidence: 'high', ...overrides });

test('capability matrix separates primary, resolution-only and unsupported layers', () => {
  const { SUPPORTED_PRIMARY, SUPPORTED_RESOLUTION_ONLY, NOT_SUPPORTED } = CAPABILITY_STATES;
  for (const name of ['direct_hls', 'direct_http', 'json_api', 'static_html',
    'iframe_http', 'multi_hop_iframe', 'navigation_header_bound']) {
    assert.equal(V2_CAPABILITY_MATRIX[name].state, SUPPORTED_PRIMARY);
  }
  for (const name of ['header_bound', 'playback_header_bound']) {
    assert.equal(V2_CAPABILITY_MATRIX[name].state, SUPPORTED_RESOLUTION_ONLY);
    assert.equal(createV2CapabilityMatrix({ playbackHeaders: true })[name].state,
      SUPPORTED_PRIMARY);
  }
  for (const name of ['cookie_session', 'javascript_transform', 'browser_required',
    'anti_bot', 'drm_or_protected', 'unknown']) {
    assert.equal(V2_CAPABILITY_MATRIX[name].state, NOT_SUPPORTED);
  }
});

test('header-bound coverage becomes primary only when playback transport is enabled', () => {
  assert.equal(classifyServerCoverage(entry(['header_bound'])).coverage, 'resolution_only');
  assert.equal(classifyServerCoverage(entry(['header_bound']), { playbackHeaders: true }).coverage,
    'primary');
  assert.equal(createCoverageSummary([entry(['playback_header_bound'])],
    { playbackHeaders: true }).primaryCompatible, 1);
});

test('coverage classification follows deterministic blocker precedence', () => {
  const cases = [
    [['direct_hls'], 'primary'],
    [['json_api'], 'primary'],
    [['static_html'], 'primary'],
    [['iframe_http'], 'primary'],
    [['multi_hop_iframe'], 'primary'],
    [['header_bound'], 'resolution_only'],
    [['playback_header_bound'], 'resolution_only'],
    [['cookie_session'], 'requires_session'],
    [['static_html', 'cookie_session'], 'requires_session'],
    [['cookie_session', 'javascript_transform'], 'requires_javascript'],
    [['javascript_transform', 'browser_required'], 'requires_browser'],
    [['anti_bot'], 'requires_browser'],
    [['drm_or_protected'], 'protected'],
    [['unknown'], 'unknown'],
    [['iframe_http', 'cookie_session'], 'requires_session'],
    [['header_bound', 'javascript_transform'], 'requires_javascript'],
  ];
  for (const [classifications, expected] of cases) {
    assert.equal(classifyServerCoverage(entry(classifications)).coverage, expected);
  }
  const mixed = classifyServerCoverage(entry(['direct_hls', 'unknown']));
  assert.equal(mixed.coverage, 'primary');
  assert.equal(mixed.confidence, 'medium');
  const all = classifyServerCoverage(entry([
    'header_bound', 'cookie_session', 'javascript_transform', 'browser_required',
    'anti_bot', 'drm_or_protected',
  ]));
  assert.equal(all.coverage, 'protected');
  assert.deepEqual(all.blockingCapabilities, ['drm_or_protected']);
});

test('summary excludes explicit inactive entries and computes bounded safe ratios', () => {
  const entries = [
    entry(['direct_hls']),
    entry(['header_bound']),
    entry(['cookie_session']),
    entry(['javascript_transform']),
    entry(['browser_required']),
    entry(['drm_or_protected']),
    entry(['unknown']),
    entry(['direct_hls'], { inactive: true }),
    { kind: 'channel', classifications: ['unknown'], confidence: 'low' },
  ];
  const summary = createCoverageSummary(entries);
  assert.equal(summary.totalScanned, 8);
  assert.equal(summary.eligible, 7);
  assert.equal(summary.inactive, 1);
  assert.equal(summary.primaryCompatible, 1);
  assert.equal(summary.resolutionOnly, 1);
  assert.equal(summary.requiresSession, 1);
  assert.equal(summary.requiresJavascript, 1);
  assert.equal(summary.requiresBrowser, 1);
  assert.equal(summary.protected, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.coveragePercent, 1 / 7);
  assert.equal(summary.technicalCoveragePercent, 2 / 7);
  assert.equal(Object.isFrozen(summary.topCombinations), true);
});

test('empty and all-inactive summaries return null percentages without NaN', () => {
  for (const summary of [createCoverageSummary([]),
    createCoverageSummary([entry(['direct_hls'], { inactive: true })])]) {
    assert.equal(summary.eligible, 0);
    assert.equal(summary.coveragePercent, null);
    assert.equal(summary.technicalCoveragePercent, null);
    assert.doesNotMatch(JSON.stringify(summary), /NaN|Infinity/);
  }
});

test('combination signatures and top ties are deterministic and capped', () => {
  assert.equal(signatureFor(['static_html', 'direct_http']),
    'direct_http+static_html');
  const entries = [];
  for (let index = 0; index < 25; index += 1) {
    entries.push(entry(['direct_hls', index % 2 ? 'json_api' : 'static_html']));
  }
  const summary = createCoverageSummary(entries);
  assert.deepEqual(summary.topCombinations.map(({ signature }) => signature), [
    'direct_hls+static_html', 'direct_hls+json_api',
  ]);
  const names = ['direct_hls', 'direct_http', 'json_api', 'static_html',
    'iframe_http', 'multi_hop_iframe'];
  const many = createCoverageSummary(Array.from({ length: 25 }, (_, index) =>
    entry(names.filter((_name, bit) => ((index + 1) & (1 << bit)) !== 0))));
  assert.equal(many.topCombinations.length, 20);
});

test('next investment is selected by largest remaining architectural block', () => {
  const recommendation = (overrides) => recommendNextCapability({
    resolutionOnly: 0, requiresSession: 0, requiresJavascript: 0,
    requiresBrowser: 0, ...overrides,
  });
  assert.equal(recommendation({ resolutionOnly: 4 }).recommendedCapability,
    'playback_headers');
  assert.equal(recommendation({ requiresSession: 5 }).recommendedCapability,
    'cookie_session');
  assert.equal(recommendation({ requiresJavascript: 6 }).recommendedCapability,
    'javascript_transform');
  assert.equal(recommendation({ requiresBrowser: 7 }).recommendedCapability,
    'browser_required');
  assert.equal(recommendation({}).recommendedCapability, 'none');
  assert.equal(recommendation({ resolutionOnly: 3, requiresSession: 3 })
    .recommendedCapability, 'playback_headers');
});

test('coverage CLI output is aggregate-only, deterministic and redacted', () => {
  assert.deepEqual(parseKodiTaxonomyArgs(
    ['--alfa-path', 'C:/tmp/alfa', '--coverage', '--json']),
  { ok: true, json: true, coverage: true, roots: ['C:/tmp/alfa'] });
  const taxonomy = {
    servers: { total: 1, active: 1, direct_hls: 1 },
    channels: { total: 0 },
    skipped: 0,
    records: [entry(['direct_hls'], {
      id: 'secret_server', url: 'https://secret.example/x?token=abc' })],
  };
  const summary = createCoverageSummary(taxonomy.records);
  const recommendation = recommendNextCapability(summary);
  const output = createCoverageOutput(taxonomy, summary, recommendation);
  assert.equal(Object.hasOwn(output.taxonomy, 'records'), false);
  for (const rendered of [formatKodiCoverageJson(taxonomy, summary, recommendation),
    formatKodiCoverageText(taxonomy, summary, recommendation)]) {
    assert.doesNotMatch(rendered, /secret_server|secret\.example|token=abc|https?:\/\//i);
  }
  assert.equal(JSON.parse(formatKodiCoverageJson(taxonomy, summary, recommendation))
    .coverage.primaryCompatible, 1);
});

test('synthetic Alfa and Balandro shapes are scanned statically without leaking content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-coverage-'));
  const alfa = path.join(root, 'plugin.video.alfa', 'servers');
  const balandro = path.join(root, 'plugin.video.balandro', 'servers');
  fs.mkdirSync(alfa, { recursive: true });
  fs.mkdirSync(balandro, { recursive: true });
  fs.writeFileSync(path.join(alfa, 'iframe_chain.py'),
    `page = requests.get('https://secret.example/x?token=abc')\niframe = parse(page)\nservertools.resolve_video_urls(iframe)`);
  fs.writeFileSync(path.join(alfa, 'iframe_chain.json'),
    JSON.stringify({ active: true, name: 'Synthetic Alfa' }));
  fs.writeFileSync(path.join(balandro, 'session_server.py'),
    `session = object()\nheaders = {'Cookie': 'PRIVATE', 'Authorization': 'PRIVATE'}`);
  fs.writeFileSync(path.join(balandro, 'disabled.json'),
    JSON.stringify({ active: false, url: 'https://hidden.example' }));
  try {
    const taxonomy = scanKodiTaxonomy({ roots: [root] });
    assert.ok(taxonomy.records.some(({ classifications }) =>
      classifications.includes('multi_hop_iframe')));
    const coverage = createCoverageSummary(taxonomy.records);
    const rendered = formatKodiCoverageJson(
      taxonomy, coverage, recommendNextCapability(coverage));
    assert.doesNotMatch(rendered,
      /secret\.example|hidden\.example|token=abc|PRIVATE/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('combined scans prioritize server coverage before channels within the hard file cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-coverage-cap-'));
  const channels = path.join(root, 'a-repository', 'channels');
  const servers = path.join(root, 'z-repository', 'servers');
  fs.mkdirSync(channels, { recursive: true });
  fs.mkdirSync(servers, { recursive: true });
  fs.writeFileSync(path.join(channels, 'a.py'), 'def search(): pass');
  fs.writeFileSync(path.join(channels, 'b.py'), 'def search(): pass');
  fs.writeFileSync(path.join(servers, 'stream.py'), 'video = "master.m3u8"');
  try {
    const taxonomy = scanKodiTaxonomy({ roots: [root], maxFiles: 2 });
    assert.equal(taxonomy.servers.total, 1);
    assert.equal(taxonomy.records.some(({ kind, id }) =>
      kind === 'server' && id === 'stream'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coverage modules are pure and contain no transport, browser or execution imports', () => {
  for (const modulePath of [
    '../src/modules/streams/resolverV2/diagnostics/v2CapabilityMatrix',
    '../src/modules/streams/resolverV2/diagnostics/capabilityCoverage',
  ]) {
    const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
    assert.doesNotMatch(source,
      /SafeHttpClient|node:http|node:https|\bfetch\s*\(|axios|ProviderC|browserSlots|ResolverExecutor|child_process|node:vm|puppeteer|playwright|selenium/i);
  }
});
