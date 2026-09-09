'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { createV2HealthStore } =
  require('../src/modules/streams/resolverV2/health/v2HealthStore');
const { createV2Observability } =
  require('../src/modules/streams/resolverV2/observability/v2Observability');

const mediaContext = {
  contentType: 'movie', contentId: 'fixture', tmdbId: 1, title: 'Fixture',
};
const candidate = (url = 'https://embed.example.test/item') => ({
  providerId: 'source_a', url, headers: {},
});
const stream = (resolverId) => ({
  url: `https://media.example.test/${resolverId}.m3u8`, protocol: 'hls',
  providerId: 'source_a', resolverId, headers: {}, validated: true,
});
const resolver = (id, priority, resolve, overrides = {}) => ({
  descriptor: {
    id, active: true, priority, strategy: 'http', protocols: ['hls'],
    domains: [], aliases: [], urlPatterns: [], requiresBrowser: false, ...overrides,
  },
  canResolve: () => true,
  resolve,
});
const engine = (resolvers, healthStore, options = {}) => createResolverEngine({
  registry: createResolverRegistry(resolvers), healthStore, timeoutMs: 100, ...options,
});

test('open resolver is skipped while another compatible resolver succeeds', async () => {
  let failingCalls = 0;
  let fallbackCalls = 0;
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 1000 });
  const failing = resolver('resolver_a', 20, async () => {
    failingCalls += 1;
    throw Object.assign(new Error('network'), { code: 'HTTP_CONNECTION_ERROR' });
  });
  const fallback = resolver('resolver_b', 10, async () => {
    fallbackCalls += 1;
    return [stream('resolver_b')];
  });
  await engine([failing, fallback], health).resolve({ mediaContext, candidates: [candidate()] });
  const result = await engine([failing, fallback], health).resolve({
    mediaContext, candidates: [candidate()],
  });
  assert.equal(failingCalls, 1);
  assert.equal(fallbackCalls, 2);
  assert.equal(result.streams[0].resolverId, 'resolver_b');
  assert.ok(result.attempts.some(({ resolverId, outcome }) =>
    resolverId === 'resolver_a' && outcome === 'circuit_open'));
});

test('empty is success, timeout is failure and recovery closes the resolver circuit', async () => {
  let now = 0;
  let shouldFail = true;
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10,
    clock: () => now });
  await engine([resolver('empty', 1, async () => [])], health).resolve({
    mediaContext, candidates: [candidate()],
  });
  assert.equal(health.get('resolver', 'empty').totalSuccesses, 1);
  const recovering = resolver('recovering', 1, async () => {
    if (shouldFail) throw Object.assign(new Error('timeout'), { code: 'HTTP_TIMEOUT' });
    return [];
  });
  await engine([recovering], health).resolve({ mediaContext, candidates: [candidate()] });
  assert.equal(health.get('resolver', 'recovering').totalTimeouts, 1);
  now = 10;
  shouldFail = false;
  await engine([recovering], health).resolve({ mediaContext, candidates: [candidate()] });
  assert.equal(health.get('resolver', 'recovering').state, 'closed');
});

test('specific circuit-open resolver does not expose endpoint to generic direct routing', async () => {
  let directCalls = 0;
  let specificCalls = 0;
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 1000 });
  const direct = resolver('direct_hls', 1000, async () => { directCalls += 1; return []; }, {
    strategy: 'direct', domains: [],
  });
  const specific = resolver('configured', 2000, async () => {
    specificCalls += 1;
    throw Object.assign(new Error('failed'), { code: 'HTTP_CONNECTION_ERROR' });
  }, { domains: ['resolver.example.test'] });
  const registry = createResolverRegistry([direct, specific]);
  const activeEngine = createResolverEngine({ registry, healthStore: health, timeoutMs: 100 });
  await activeEngine.resolve({ mediaContext,
    candidates: [candidate('https://resolver.example.test/item')] });
  const result = await activeEngine.resolve({ mediaContext,
    candidates: [candidate('https://resolver.example.test/item')] });
  assert.equal(specificCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(result.streams.length, 0);
});

test('external abort is not penalized and health/observability failures are isolated', async () => {
  const health = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10 });
  const controller = new AbortController();
  const slow = resolver('slow', 1, async (_candidate, context) =>
    new Promise((resolve, reject) => context.signal.addEventListener('abort', reject,
      { once: true })));
  const pending = engine([slow], health).resolve({
    mediaContext, candidates: [candidate()], signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'RESOLVER_ENGINE_ABORTED');
  assert.equal(health.get('resolver', 'slow').totalFailures, 0);

  const brokenHealth = new Proxy({}, { get: () => () => { throw new Error('broken'); } });
  const result = await engine([resolver('ok', 1, async () => [stream('ok')])], brokenHealth, {
    observability: { observe: () => { throw new Error('broken'); } },
  }).resolve({ mediaContext, candidates: [candidate()] });
  assert.equal(result.streams.length, 1);
});

test('static resolver strategy histograms receive observations', async () => {
  const observability = createV2Observability();
  await engine([
    resolver('http', 2, async () => []),
    resolver('direct', 1, async () => [], { strategy: 'direct' }),
  ], null, { observability }).resolve({ mediaContext, candidates: [candidate()] });
  const snapshot = observability.snapshot();
  assert.equal(snapshot.latency.resolver_http.count, 1);
  assert.equal(snapshot.latency.resolver_direct.count, 1);
});
