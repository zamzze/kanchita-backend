'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://canary:canary@127.0.0.1:5432/canary';
process.env.JWT_SECRET ||= 'canary-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'canary-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'canary-test-tmdb';

const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
const { createPrimaryRuntimeGuard } =
  require('../../src/modules/streams/resolverV2/health/primaryRuntimeGuard');
const { createPrimaryStats } =
  require('../../src/modules/streams/resolverV2/observability/primaryStats');

const job = { content_type: 'movie', content_id: 'fixture', job_type: 'resolve' };
const legacy = { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
const selected = {
  url: 'https://v2.example.test/master.m3u8', protocol: 'hls', providerId: 'source',
  resolverId: 'direct_hls', headers: {}, validated: true, quality: '720p',
  audioLanguage: 'es-419', subtitleLanguage: null, expiresAt: null, latencyMs: 1,
  hlsInfo: null, metadata: { resolverStrategy: 'direct' },
};
const accepted = { status: 'accepted', selected,
  summary: { code: 'PRIMARY_ACCEPTED' }, externalAbort: false };

const harness = (overrides = {}) => {
  const calls = { primary: 0, shadow: 0, legacy: 0 };
  const processor = createStreamProcessor({
    db: { query: async () => {} }, resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }),
    findContent: async () => ({ tmdb_id: 1, title: 'Fixture' }),
    primaryEnabled: true, shadowEnabled: false, primaryRolloutPercent: 100,
    primaryGuardEnabled: true, primaryGuardMinimumAttempts: 3,
    primaryGuardWindowSize: 4, primaryGuardFailureRatePercent: 50,
    primaryGuardTimeoutRatePercent: 40, primaryGuardCooldownSeconds: 10,
    primaryResolver: { resolve: async () => { calls.primary += 1; return accepted; } },
    shadowResolver: { run: async () => { calls.shadow += 1; return { status: 'empty' }; } },
    providerManager: { resolve: async () => { calls.legacy += 1; return legacy; } },
    lifecycle: { readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id,
        title: content.title,
      }) },
    stats: { recordReady: async () => {} }, primaryMetrics: { increment: async () => {} },
    logger: { log: () => {}, warn: () => {} }, ...overrides,
  });
  return { processor, calls };
};

test('zero and non-selected rollout use legacy only without shadow or primary', async () => {
  for (const options of [
    { primaryRolloutPercent: 0 },
    { primaryRolloutGate: { evaluate: () => ({ eligible: false,
      reason: 'rollout_not_selected', bucket: 9000 }) } },
  ]) {
    const { processor, calls } = harness({ shadowEnabled: true, ...options });
    assert.equal(await processor(job), legacy);
    assert.deepEqual(calls, { primary: 0, shadow: 0, legacy: 1 });
  }
});

test('fully selected accepted primary remains authoritative', async () => {
  const { processor, calls } = harness({ primaryRolloutPercent: 100, shadowEnabled: true });
  assert.equal((await processor(job)).url, selected.url);
  assert.deepEqual(calls, { primary: 1, shadow: 0, legacy: 0 });
});

test('selected rejected, timeout and failed outcomes fall back exactly once', async () => {
  for (const status of ['rejected', 'timeout', 'failed']) {
    const { processor, calls } = harness({ primaryResolver: { resolve: async () => {
      calls.primary += 1;
      return { status, selected: null, summary: { code: 'PRIMARY_UNKNOWN' },
        externalAbort: false };
    } } });
    assert.equal(await processor(job), legacy);
    assert.deepEqual(calls, { primary: 1, shadow: 0, legacy: 1 });
  }
});

test('open guard bypasses primary but never blocks legacy', async () => {
  const guard = createPrimaryRuntimeGuard({ minimumAttempts: 3, windowSize: 3,
    failureRateThreshold: 50, timeoutRateThreshold: 40, cooldownMs: 10_000 });
  guard.recordOutcome('failed'); guard.recordOutcome('failed'); guard.recordOutcome('failed');
  const { processor, calls } = harness({ primaryRuntimeGuard: guard });
  assert.equal(await processor(job), legacy);
  assert.deepEqual(calls, { primary: 0, shadow: 0, legacy: 1 });
});

test('one processor shares guard state across jobs and recovers through one probe', async () => {
  let now = 1_000;
  const guard = createPrimaryRuntimeGuard({ minimumAttempts: 3, windowSize: 3,
    failureRateThreshold: 50, timeoutRateThreshold: 40, cooldownMs: 10_000,
    clock: () => now });
  let outcome = 'failed';
  const { processor, calls } = harness({ primaryRuntimeGuard: guard,
    primaryResolver: { resolve: async () => { calls.primary += 1; return outcome === 'accepted'
      ? accepted : { status: 'failed', selected: null, summary: { code: 'PRIMARY_UNKNOWN' },
        externalAbort: false }; } } });
  for (let index = 0; index < 3; index += 1) assert.equal(await processor(job), legacy);
  assert.equal(guard.snapshot().state, 'open');
  assert.equal(await processor(job), legacy);
  assert.equal(calls.primary, 3);
  now += 10_000;
  outcome = 'accepted';
  assert.equal((await processor(job)).url, selected.url);
  assert.equal(guard.snapshot().state, 'closed');
  assert.equal(calls.primary, 4);
});

test('primary false ignores rollout and preserves shadow mode', async () => {
  const { processor, calls } = harness({ primaryEnabled: false, shadowEnabled: true });
  assert.equal(await processor(job), legacy);
  assert.deepEqual(calls, { primary: 0, shadow: 1, legacy: 1 });
});

test('canary telemetry failures cannot alter primary or fallback correctness', async () => {
  const brokenStats = { record: () => { throw new Error('stats'); },
    recordRollout: () => { throw new Error('stats'); },
    recordGuard: () => { throw new Error('stats'); } };
  const { processor, calls } = harness({ primaryStats: brokenStats,
    primaryMetrics: { increment: () => { throw new Error('metrics'); } } });
  assert.equal((await processor(job)).url, selected.url);
  assert.deepEqual(calls, { primary: 1, shadow: 0, legacy: 0 });
});

test('extended stats distinguish selection, attempts, fallback and avoidance', () => {
  const stats = createPrimaryStats();
  stats.recordRollout('selected');
  stats.record({ status: 'accepted', legacyAvoided: true });
  stats.recordRollout('rollout_not_selected');
  stats.recordGuard('skip');
  const snapshot = stats.snapshot();
  assert.equal(snapshot.rolloutEvaluations, 2);
  assert.equal(snapshot.eligible, 1);
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.legacyAvoided, 1);
  assert.equal(snapshot.eligibilityRate, 0.5);
  assert.equal(snapshot.primaryExecutionRate, 0.5);
  assert.equal(snapshot.legacyAvoidanceOverall, 0.5);
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:|contentId|tmdbId|token|Cookie/i);
});
