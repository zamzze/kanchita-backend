'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  parsePreflightArgs,
  exitCodeForStatus,
  safeOutput,
  formatPreflightJson,
  formatPreflightText,
} = require('../src/modules/streams/resolverV2/preflight/preflightCli');

test('strict CLI parser accepts movie, episode and catalog-only modes', () => {
  assert.deepEqual(parsePreflightArgs(['--movie', '550']), {
    ok: true, json: false, catalogOnly: false, timeoutMs: 10_000,
    mediaContext: { contentType: 'movie', tmdbId: 550 },
  });
  assert.deepEqual(parsePreflightArgs(['--episode', '1399', '--season', '0',
    '--episode-number', '3', '--timeout-ms', '30000', '--json']), {
    ok: true, json: true, catalogOnly: false, timeoutMs: 30_000,
    mediaContext: { contentType: 'episode', tmdbId: 1399, season: 0, episode: 3 },
  });
  assert.deepEqual(parsePreflightArgs(['--catalog-only', '--json']), {
    ok: true, json: true, catalogOnly: true, timeoutMs: 10_000, mediaContext: null,
  });
});

test('CLI parser rejects missing, conflicting, repeated and unsafe arguments', () => {
  const invalid = [
    [], ['--movie', '0'], ['--movie', '-1'], ['--movie', 'x'],
    ['--episode', '1'], ['--episode', '1', '--season', '1'],
    ['--episode', '1', '--season', '-1', '--episode-number', '1'],
    ['--episode', '1', '--season', '1', '--episode-number', '0'],
    ['--movie', '1', '--episode', '2', '--season', '1', '--episode-number', '1'],
    ['--movie', '1', '--season', '1'], ['--unknown'], ['--token', 'secret'],
    ['--header', 'Authorization:x'], ['--allow-private'],
    ['--movie', '1', '--movie', '2'], ['--json', '--json'],
    ['--catalog-only', '--movie', '1'], ['--timeout-ms', '999', '--movie', '1'],
    ['--timeout-ms', '30001', '--movie', '1'], ['--timeout-ms', 'x', '--movie', '1'],
    ['--timeout-ms', '1.5', '--movie', '1'], ['--movie', '1.5'],
  ];
  for (const args of invalid) {
    assert.equal(parsePreflightArgs(args).ok, false, args.join(' '));
  }
});

test('exit codes are fixed for ready, invalid, unavailable, timeout and failures', () => {
  assert.equal(exitCodeForStatus('ready'), 0);
  assert.equal(exitCodeForStatus('invalid_context', { cliInputInvalid: true }), 2);
  for (const status of ['no_sources', 'no_candidates', 'no_streams', 'rejected']) {
    assert.equal(exitCodeForStatus(status), 3);
  }
  assert.equal(exitCodeForStatus('timeout'), 4);
  for (const status of ['failed', 'invalid_context', 'aborted', 'unexpected']) {
    assert.equal(exitCodeForStatus(status), 5);
  }
});

test('text and JSON formatters expose only their deterministic allowlist', () => {
  const unsafe = {
    status: 'ready', mediaType: 'movie', durationMs: 12,
    url: 'https://very-secret-host.example.test/private/path/abc?token=XYZ',
    title: 'PRIVATE TITLE', contentId: 'secret-content-id', tmdbId: 999999,
    headers: { Authorization: 'super-secret-source', Cookie: 'super-secret-resolver' },
    catalog: { enabled: true, loaded: true, version: 1, sourcesRegistered: 2,
      resolversRegistered: 3, entriesSkipped: 1, errorCodes: ['CATALOG_INVALID_SOURCE'],
      path: '/secret/catalog.json', authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE' },
    sourceSummary: { registered: 2, eligible: 2, attempted: 2, succeeded: 2,
      candidates: 3 },
    resolverSummary: { registered: 3, attempted: 2, succeeded: 2, streams: 2 },
    rankingSummary: { streamCount: 2, languages: { latino: 1 },
      qualities: { '720p': 1 }, protocols: { hls: 2 },
      selected: { validated: true, protocolTier: 'hls', languageTier: 'latino',
        qualityTier: '720p', url: 'https://secret.example.test' } },
    acceptanceSummary: { accepted: true, code: 'PRIMARY_ACCEPTED',
      headersSupported: true },
    healthSummary: { sources: { closed: 2 }, resolvers: { closed: 2 } },
    observabilitySummary: { totalMs: { p50: 12, p95: 12 } },
  };
  const safe = safeOutput(unsafe);
  const json = formatPreflightJson(unsafe);
  const text = formatPreflightText(unsafe);
  assert.deepEqual(JSON.parse(json), safe);
  assert.equal(formatPreflightJson(unsafe), formatPreflightJson(unsafe));
  assert.equal(formatPreflightText(unsafe), formatPreflightText(unsafe));
  assert.equal(json.trim().split('\n').length, 1);
  assert.equal(text.split('\n')[0], 'Resolver V2 preflight');
  assert.equal(text.split('\n').at(-1), 'duration_ms=12');
  for (const output of [JSON.stringify(safe), json, text]) {
    assert.doesNotMatch(output, /very-secret|private\/path|XYZ|PRIVATE TITLE|secret-content|999999|Authorization|Cookie|super-secret|authTokenEnv|catalog\.json/i);
  }
});

test('importing the CLI entrypoint installs no listeners and starts no runtime', () => {
  const entry = path.join(__dirname, '..', 'scripts', 'resolver-v2-preflight.js');
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  const loaded = require(entry);
  assert.equal(typeof loaded.main, 'function');
  assert.deepEqual({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') },
    before);
  const source = fs.readFileSync(entry, 'utf8');
  assert.match(source, /require\.main === module/);
  assert.doesNotMatch(source, /process\.exit\s*\(/);
});

test('preflight modules have no legacy, browser, DB, API or direct transport coupling', () => {
  const files = [
    '../src/modules/streams/resolverV2/preflight/preflightErrors.js',
    '../src/modules/streams/resolverV2/preflight/preflightRunner.js',
    '../src/modules/streams/resolverV2/preflight/preflightCli.js',
    '../scripts/resolver-v2-preflight.js',
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.doesNotMatch(source,
      /ProviderC|providerManager|providerRegistry|browserSlots|ResolverExecutor|streamResolverChild|puppeteer|streams\.queries|streamLifecycle|express|child_process/i,
      relative);
    assert.doesNotMatch(source, /\bfetch\s*\(|http\.get|https\.get|axios/i, relative);
  }
});
