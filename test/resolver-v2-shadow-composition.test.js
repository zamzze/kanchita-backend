'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'shadow-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'shadow-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'shadow-test-tmdb';
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { METRIC_NAMES, createMetricsStore } =
  require('../src/modules/streams/streamMetrics');

const root = path.join(__dirname, '..');
const mediaContext = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10, title: 'Fixture',
};

test('production composition starts with zero sources and direct HLS resolver only', async () => {
  let networkCalls = 0;
  const composition = createShadowPipeline({
    enabled: true,
    httpClient: {
      get: async () => { networkCalls += 1; throw new Error('unexpected network'); },
      head: async () => { networkCalls += 1; throw new Error('unexpected network'); },
    },
    metrics: { increment: async () => {}, observe: async () => {} },
    logger: { log: () => {} },
  });
  assert.deepEqual(composition.sourceRegistry.list(), []);
  assert.deepEqual(composition.resolverRegistry.list().map((item) => item.descriptor.id),
    ['direct_hls']);
  const startedAt = Date.now();
  const result = await composition.shadowResolver.run(mediaContext);
  assert.equal(result.status, 'no_providers');
  assert.equal(networkCalls, 0);
  assert.ok(Date.now() - startedAt < 100);
});

test('configured HTTP source is registered only when enabled with valid configuration', () => {
  const httpClient = {
    get: async () => { throw new Error('construction must not request'); },
    head: async () => { throw new Error('construction must not request'); },
  };
  const disabled = createShadowPipeline({
    httpClient, httpProvider: { enabled: false, baseUrl: 'https://source.example.test' },
  });
  const invalid = createShadowPipeline({
    httpClient, httpProvider: { enabled: true, baseUrl: 'file:///unsafe' },
  });
  const invalidId = createShadowPipeline({
    httpClient, httpProvider: {
      enabled: true, id: 'INVALID ID', baseUrl: 'https://source.example.test',
    },
  });
  assert.deepEqual(disabled.sourceRegistry.list(), []);
  assert.deepEqual(invalid.sourceRegistry.list(), []);
  assert.deepEqual(invalidId.sourceRegistry.list(), []);

  const configured = createShadowPipeline({
    httpClient,
    httpProvider: {
      enabled: true, id: 'provider_a', baseUrl: 'https://source.example.test/api',
      timeoutMs: 2000, maxCandidates: 8,
    },
  });
  assert.equal(configured.sourceRegistry.list().length, 1);
  assert.equal(configured.sourceRegistry.list()[0].descriptor.id, 'provider_a');
  assert.equal(configured.sourceRegistry.list()[0].descriptor.strategy, 'http');
  assert.deepEqual(configured.resolverRegistry.list().map((item) => item.descriptor.id),
    ['direct_hls']);
});

test('shadow composition has no browser, legacy executor, DB or import-time network coupling', () => {
  for (const relative of [
    'shadowResolver.js', 'createShadowPipeline.js', 'resolutionPipeline.js',
  ]) {
    const source = fs.readFileSync(path.join(
      root, 'src', 'modules', 'streams', 'resolverV2', relative
    ), 'utf8');
    assert.doesNotMatch(source,
      /ProviderC|providerC|legacyBrowserAdapter|ResolverExecutor|resolverExecutor|browserSlots|puppeteer|child_process|config\/db|streams\.queries/i);
    assert.doesNotMatch(source, /\bfetch\s*\(|https?\.get\s*\(/i);
  }
});

test('all shadow metric names are accepted by the existing metrics store', async () => {
  const names = [
    'resolver_v2_shadow_attempt_total', 'resolver_v2_shadow_success_total',
    'resolver_v2_shadow_empty_total', 'resolver_v2_shadow_failure_total',
    'resolver_v2_shadow_timeout_total', 'resolver_v2_shadow_duration_ms',
  ];
  for (const name of names) assert.equal(METRIC_NAMES.has(name), true);
  const calls = [];
  const store = createMetricsStore({ query: async (sql, values) => calls.push({ sql, values }) });
  for (const name of names.slice(0, -1)) await store.increment(name);
  await store.observe(names.at(-1), 12);
  assert.equal(calls.length, names.length);
});
