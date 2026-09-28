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

test('production composition starts with zero sources and direct media resolvers only', async () => {
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
    ['direct_hls', 'direct_mp4']);
  assert.ok(composition.healthStore);
  assert.ok(composition.observability);
  assert.equal(typeof composition.ranker.selectBest, 'function');
  assert.equal(typeof composition.shadowComparator.compare, 'function');
  assert.equal(typeof composition.comparisonStats.snapshot, 'function');
  assert.equal(typeof composition.primaryResolver.resolve, 'function');
  assert.equal(typeof composition.primaryStats.snapshot, 'function');
  const startedAt = Date.now();
  const result = await composition.shadowResolver.run(mediaContext);
  assert.equal(result.status, 'no_providers');
  assert.equal(networkCalls, 0);
  assert.ok(Date.now() - startedAt < 100);
});

test('health disabled bypasses V2 gating while retaining observability', () => {
  const composition = createShadowPipeline({
    healthEnabled: false,
    httpClient: { get: async () => {}, head: async () => {} },
  });
  assert.equal(composition.healthStore, null);
  assert.ok(composition.observability);
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
    ['direct_hls', 'direct_mp4']);
});

test('Pluto is opt-in and accepts the mapping resolver with legacy store compatibility', () => {
  const httpClient = {
    get: async () => { throw new Error('construction must not request'); },
    head: async () => { throw new Error('construction must not request'); },
  };
  const withoutStore = createShadowPipeline({ httpClient,
    plutoProvider: { enabled: true } });
  assert.deepEqual(withoutStore.sourceRegistry.list(), []);
  const withStore = createShadowPipeline({ httpClient,
    providerMappingStore: { findActiveMapping: async () => null },
    plutoProvider: { enabled: true } });
  assert.deepEqual(withStore.sourceRegistry.list().map(({ descriptor }) => descriptor.id),
    ['pluto']);
  const withResolver = createShadowPipeline({ httpClient,
    providerMappingResolver: { resolve: async () => [] },
    plutoProvider: { enabled: true } });
  assert.deepEqual(withResolver.sourceRegistry.list().map(({ descriptor }) => descriptor.id),
    ['pluto']);
});

test('catalog mapped workflow reuses the injected mapping resolver and skips without it', () => {
  const entry = { id: 'workflow_a', type: 'mapped_http_workflow', enabled: true,
    region: 'global', baseUrl: 'https://workflow.example.test', workflow: [
      { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'payload' },
    ] };
  const options = { catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1, sources: [entry] }),
    httpClient: { request: async () => { throw new Error('construction must not request'); },
      get: async () => { throw new Error('construction must not request'); },
      head: async () => { throw new Error('construction must not request'); } },
    healthEnabled: false };
  const mappingResolver = { resolve: async () => [] };
  const configured = createShadowPipeline({ ...options, providerMappingResolver: mappingResolver });
  assert.deepEqual(configured.sourceRegistry.list().map(({ descriptor }) => descriptor.id),
    ['workflow_a']);
  assert.equal(configured.sourceRegistry.list().length, 1);
  const skipped = createShadowPipeline(options);
  assert.deepEqual(skipped.sourceRegistry.list(), []);
  assert.deepEqual(skipped.catalogSummary.errorCodes,
    ['MAPPED_SOURCE_MAPPING_RESOLVER_UNAVAILABLE']);
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
    'resolver_v2_source_circuit_open_total', 'resolver_v2_source_circuit_skip_total',
    'resolver_v2_source_half_open_probe_total',
    'resolver_v2_source_circuit_recovery_total',
    'resolver_v2_resolver_circuit_open_total', 'resolver_v2_resolver_circuit_skip_total',
    'resolver_v2_resolver_half_open_probe_total',
    'resolver_v2_resolver_circuit_recovery_total',
    'resolver_v2_shadow_comparison_total',
    'resolver_v2_shadow_ready_comparison_total',
    'resolver_v2_shadow_would_avoid_browser_total',
    'resolver_v2_legacy_browser_total',
    'resolver_v2_shadow_better_total',
    'resolver_v2_shadow_equivalent_total',
    'resolver_v2_shadow_legacy_better_total',
    'resolver_v2_primary_attempt_total',
    'resolver_v2_primary_success_total',
    'resolver_v2_primary_fallback_total',
    'resolver_v2_primary_timeout_total',
    'resolver_v2_primary_failure_total',
    'resolver_v2_primary_rejected_total',
    'resolver_v2_primary_legacy_avoided_total',
    'resolver_v2_primary_duration_ms',
  ];
  for (const name of names) assert.equal(METRIC_NAMES.has(name), true);
  const calls = [];
  const store = createMetricsStore({ query: async (sql, values) => calls.push({ sql, values }) });
  for (const name of names.filter((name) => !name.endsWith('duration_ms'))) {
    await store.increment(name);
  }
  for (const name of names.filter((name) => name.endsWith('duration_ms'))) {
    await store.observe(name, 12);
  }
  assert.equal(calls.length, names.length);
});
