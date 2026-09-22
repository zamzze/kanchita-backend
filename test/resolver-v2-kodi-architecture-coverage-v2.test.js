'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RUNTIME_COMMIT,
  createArchitectureCoverageV2,
  createKanchitaCapabilityProfile,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiArchitectureCoverageV2');
const {
  formatKodiArchitectureJson,
  formatKodiArchitectureText,
  parseKodiTaxonomyArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const record = (id, architectureFamily, classifications = [], overrides = {}) => ({
  id, kind: 'server', architectureFamily, classifications,
  architectureSignals: [], architectureObservations: [], confidence: 'medium',
  ...overrides,
});

test('coverage V2 flag is opt-in and requires architecture details', () => {
  const root = ['--balandro-path', 'C:/fixtures/balandro'];
  assert.equal(parseKodiTaxonomyArgs([...root, '--architecture-coverage-v2']).ok, false);
  assert.equal(parseKodiTaxonomyArgs(
    [...root, '--architecture', '--architecture-coverage-v2']).ok, false);
  assert.deepEqual(parseKodiTaxonomyArgs([...root, '--architecture',
    '--architecture-details', '--architecture-coverage-v2', '--json']), {
    ok: true, json: true, coverage: false, architecture: true,
    architectureDetails: true, architectureCoverageV2: true,
    roots: ['C:/fixtures/balandro'],
  });
});

test('runtime capability profile is deterministic and reflects audited bounded limits', () => {
  const first = createKanchitaCapabilityProfile();
  const second = createKanchitaCapabilityProfile();
  assert.deepEqual(first, second);
  assert.equal(first.runtimeCommit, RUNTIME_COMMIT);
  assert.equal(first.runtimeCommit, '0ea33378f38e349d5b2168974c6ec861ab406d0e');
  assert.deepEqual(first.transport.methods, ['GET', 'HEAD', 'POST']);
  assert.equal(first.httpWorkflow.maxSteps, 8);
  assert.equal(first.jsonPath.maximumArrayIndex, 31);
  assert.equal(first.resolutionGraph.maximumDepth, 4);
  assert.equal(first.resolutionGraph.maximumNodes, 64);
  assert.equal(first.media.playbackTransport, true);
  assert.equal(first.unsupported.persistentCookies, false);
  assert.equal(first.unsupported.javascriptTransform, false);
  assert.equal(Object.isFrozen(first.httpWorkflow), true);
});

test('simple HTML, JSON API and header-bound HLS need provider configuration', () => {
  const coverage = createArchitectureCoverageV2([
    record('html', 'DECLARATIVE_HTML', ['static_html', 'iframe_http'], {
      architectureSignals: ['extracts_iframe'],
    }),
    record('api', 'HTTP_API', ['json_api', 'direct_http'], {
      architectureSignals: ['json_endpoint'],
    }),
    record('headers', 'HLS_WITH_HEADERS', ['direct_hls', 'header_bound'], {
      architectureSignals: ['direct_m3u8', 'uses_referer'],
    }),
  ]);
  assert.deepEqual(coverage.servers.map(({ server, assessment }) => [server, assessment]), [
    ['api', 'NEEDS_PROVIDER_CONFIG'],
    ['headers', 'NEEDS_PROVIDER_CONFIG'],
    ['html', 'NEEDS_PROVIDER_CONFIG'],
  ]);
  const headers = coverage.servers.find(({ server }) => server === 'headers');
  assert.ok(headers.availableCapabilities.includes('playback_headers'));
  assert.deepEqual(headers.missingCapabilities, []);
});

test('unsupported families retain conservative explicit assessments', () => {
  const coverage = createArchitectureCoverageV2([
    record('session', 'SESSION_HTTP', ['cookie_session']),
    record('javascript', 'JAVASCRIPT_TRANSFORM', ['javascript_transform']),
    record('browser', 'DECLARATIVE_HTML', ['static_html', 'browser_required']),
    record('manifest', 'MANIFEST_SYNTHESIS', ['direct_hls'], {
      architectureSignals: ['manifest_extm3u', 'manifest_extinf'],
    }),
    record('unknown', 'UNKNOWN', ['unknown']),
  ]);
  assert.deepEqual(Object.fromEntries(coverage.servers.map((item) =>
    [item.server, item.assessment])), {
    browser: 'UNSUPPORTED_BROWSER',
    javascript: 'UNSUPPORTED_JAVASCRIPT',
    manifest: 'UNSUPPORTED_MANIFEST',
    session: 'UNSUPPORTED_SESSION',
    unknown: 'UNKNOWN',
  });
});

test('missing capability calculation distinguishes direct files and bounded regex gaps', () => {
  const coverage = createArchitectureCoverageV2([
    record('mp4', 'DIRECT_MEDIA', ['direct_http'], {
      architectureSignals: ['direct_mp4'],
    }),
    record('regex_html', 'DECLARATIVE_HTML', ['static_html'], {
      architectureObservations: ['regex.re'],
    }),
  ]);
  assert.deepEqual(coverage.servers[0].missingCapabilities, ['direct_http']);
  assert.deepEqual(coverage.servers[1].missingCapabilities, ['html_regex_transform']);
  assert.ok(coverage.servers.every(({ assessment }) =>
    assessment === 'NEEDS_SMALL_GENERIC_COMPONENT'));
});

test('classified siblings deduplicate server identity without hiding module count', () => {
  const coverage = createArchitectureCoverageV2([
    record('paired', 'UNKNOWN', ['unknown']),
    record('paired', 'HTTP_API', ['json_api'], {
      architectureSignals: ['json_endpoint'], confidence: 'high',
    }),
    record('single', 'UNKNOWN', ['unknown']),
  ]);
  assert.equal(coverage.summary.modules, 3);
  assert.equal(coverage.summary.uniqueServers, 2);
  assert.equal(coverage.servers[0].server, 'paired');
  assert.equal(coverage.servers[0].files, 2);
  assert.equal(coverage.servers[0].architecture, 'HTTP_API');
  assert.equal(coverage.servers[0].assessment, 'NEEDS_PROVIDER_CONFIG');
  assert.equal(coverage.byArchitecture.HTTP_API.modules, 1);
  assert.equal(coverage.byArchitecture.HTTP_API.uniqueServers, 1);
  assert.equal(coverage.byArchitecture.UNKNOWN.modules, 2);
  assert.equal(coverage.byArchitecture.UNKNOWN.uniqueServers, 2);
});

test('configured equivalents are the only records considered representable now', () => {
  const records = [record('api', 'HTTP_API', ['json_api'], {
    architectureSignals: ['json_endpoint'],
  })];
  assert.equal(createArchitectureCoverageV2(records).servers[0].assessment,
    'NEEDS_PROVIDER_CONFIG');
  assert.equal(createArchitectureCoverageV2(records,
    { configuredServerIds: ['api'] }).servers[0].assessment, 'REPRESENTABLE_NOW');
});

test('coverage and JSON output are deterministic, alphabetical and contain no source data', () => {
  const records = [
    record('zeta', 'UNKNOWN', ['unknown'], {
      source: 'https://private.example/?token=SECRET',
    }),
    record('alpha', 'SESSION_HTTP', ['cookie_session']),
  ];
  const left = createArchitectureCoverageV2(records);
  const right = createArchitectureCoverageV2([...records].reverse());
  assert.deepEqual(left, right);
  assert.deepEqual(left.servers.map(({ server }) => server), ['alpha', 'zeta']);
  const taxonomy = { servers: { total: 2, active: 2 }, channels: { total: 0 }, skipped: 0 };
  const architecture = { total: 2, UNKNOWN: 1, SESSION_HTTP: 1 };
  const details = { counts: architecture,
    serversByArchitecture: { UNKNOWN: ['zeta'], SESSION_HTTP: ['alpha'] } };
  const output = formatKodiArchitectureJson(taxonomy, architecture, details, null, left);
  assert.deepEqual(JSON.parse(output).coverageV2, left);
  assert.doesNotMatch(output, /private\.example|SECRET|https?:\/\//i);
});

test('legacy architecture output is byte-identical when coverage is absent', () => {
  const taxonomy = { servers: { total: 1, active: 1 }, channels: { total: 0 }, skipped: 0 };
  const architecture = { total: 1, UNKNOWN: 1 };
  const details = { counts: architecture, serversByArchitecture: { UNKNOWN: ['x'] } };
  assert.equal(formatKodiArchitectureJson(taxonomy, architecture, details),
    formatKodiArchitectureJson(taxonomy, architecture, details, null, null));
  assert.equal(formatKodiArchitectureText(taxonomy, architecture, details),
    formatKodiArchitectureText(taxonomy, architecture, details, null, null));
});

test('coverage implementation remains static and cannot execute or access the network', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiArchitectureCoverageV2'), 'utf8');
  assert.doesNotMatch(source,
    /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|dynamic\s+import|new Function|\beval\s*\(/i);
});
