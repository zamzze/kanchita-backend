'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { createV2HealthStore } =
  require('../src/modules/streams/resolverV2/health/v2HealthStore');
const { createV2Observability } =
  require('../src/modules/streams/resolverV2/observability/v2Observability');

const media = { contentType: 'movie', contentId: 'fixture', tmdbId: 1, title: 'Fixture' };
const provider = (id, getSources, priority = 10) => ({
  descriptor: {
    id, active: true, priority, supportsMovies: true, supportsEpisodes: true,
    languages: [], strategy: 'http', timeoutMs: 50, maxCandidates: 4,
  },
  getSources,
});
const manager = (providers, healthStore, options = {}) => createSourceProviderManager({
  registry: createSourceProviderRegistry(providers), healthStore,
  providerTimeoutMs: 50, globalTimeoutMs: 200, ...options,
});

test('source circuit opens, skips only the degraded provider and recovers by probe', async () => {
  let clock = 0;
  let failingCalls = 0;
  let healthyCalls = 0;
  let recover = false;
  const health = createV2HealthStore({ failureThreshold: 2, cooldownMs: 10,
    clock: () => clock });
  const providers = [
    provider('failing', async () => {
      failingCalls += 1;
      if (!recover) throw new Error('network');
      return [];
    }, 20),
    provider('healthy', async () => { healthyCalls += 1; return []; }, 10),
  ];
  await manager(providers, health).getSources(media);
  await manager(providers, health).getSources(media);
  const skipped = await manager(providers, health).getSources(media);
  assert.equal(failingCalls, 2);
  assert.equal(healthyCalls, 3);
  assert.equal(skipped.trace.providersCircuitOpen, 1);
  assert.equal(health.get('source', 'failing').state, 'open');
  clock = 10;
  recover = true;
  await manager(providers, health).getSources(media);
  assert.equal(failingCalls, 3);
  assert.equal(health.get('source', 'failing').state, 'closed');
});

test('empty results are healthy while individual timeout counts as failure', async () => {
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 100 });
  await manager([provider('empty', async () => [])], health).getSources(media);
  assert.equal(health.get('source', 'empty').totalSuccesses, 1);
  assert.equal(health.get('source', 'empty').state, 'closed');

  await manager([provider('slow', async () => new Promise(() => {}))], health, {
    providerTimeoutMs: 10,
  }).getSources(media);
  assert.equal(health.get('source', 'slow').state, 'open');
  assert.equal(health.get('source', 'slow').totalTimeouts, 1);
});

test('external abort is not recorded and releases half-open ownership', async () => {
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 1 });
  const controller = new AbortController();
  const pending = manager([provider('slow', async (_media, runtime) =>
    new Promise((resolve, reject) => runtime.signal.addEventListener('abort', reject,
      { once: true })))], health).getSources(media, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'SOURCE_PROVIDER_ABORTED');
  assert.equal(health.get('source', 'slow').totalFailures, 0);
});

test('health failures are best-effort and source latency uses static HTTP series', async () => {
  let calls = 0;
  const broken = new Proxy({}, { get: () => () => { throw new Error('health broken'); } });
  const observability = createV2Observability();
  const result = await manager([provider('healthy', async () => { calls += 1; return []; })],
    broken, { observability }).getSources(media);
  assert.equal(result.trace.providersSucceeded, 1);
  assert.equal(calls, 1);
  assert.equal(observability.snapshot().latency.source_http.count, 1);
});

test('without a health store provider attempts retain previous behavior', async () => {
  let calls = 0;
  const active = manager([provider('failing', async () => {
    calls += 1;
    throw new Error('failure');
  })], null);
  await active.getSources(media);
  await active.getSources(media);
  assert.equal(calls, 2);
});