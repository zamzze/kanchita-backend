'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPrimaryRuntimeGuard } =
  require('../src/modules/streams/resolverV2/health/primaryRuntimeGuard');

const make = (overrides = {}) => {
  let now = 1_000;
  const guard = createPrimaryRuntimeGuard({ minimumAttempts: 3, windowSize: 4,
    failureRateThreshold: 50, timeoutRateThreshold: 40, cooldownMs: 10_000,
    clock: () => now, ...overrides });
  return { guard, advance: (ms) => { now += ms; } };
};

test('guard starts closed and neutral outcomes do not enter technical denominator', () => {
  const { guard } = make();
  assert.deepEqual(guard.canAttempt(), { allowed: true, state: 'closed', probe: false });
  guard.recordOutcome('empty');
  guard.recordOutcome('rejected');
  assert.equal(guard.snapshot().technicalAttempts, 0);
  assert.equal(guard.snapshot().state, 'closed');
});

test('minimum attempts and failure/timeout thresholds open the guard', () => {
  const failure = make().guard;
  failure.recordOutcome('failed');
  failure.recordOutcome('accepted');
  assert.equal(failure.snapshot().state, 'closed');
  assert.equal(failure.recordOutcome('failed').event, 'open');
  assert.equal(failure.canAttempt().allowed, false);

  const timeout = make().guard;
  timeout.recordOutcome('timeout');
  timeout.recordOutcome('accepted');
  timeout.recordOutcome('timeout');
  assert.equal(timeout.snapshot().state, 'open');
  assert.equal(timeout.snapshot().timeoutRate, 2 / 3);
});

test('rolling window is bounded and evicts old failures', () => {
  const { guard } = make({ minimumAttempts: 3, windowSize: 4,
    failureRateThreshold: 100, timeoutRateThreshold: 100 });
  guard.recordOutcome('failed');
  for (let index = 0; index < 10_000; index += 1) guard.recordOutcome('accepted');
  const snapshot = guard.snapshot();
  assert.equal(snapshot.technicalAttempts, 4);
  assert.equal(snapshot.failures, 0);
  assert.equal(snapshot.failureRate, 0);
});

test('cooldown admits one half-open probe and accepted/neutral outcomes recover', async () => {
  for (const outcome of ['accepted', 'empty', 'rejected']) {
    const { guard, advance } = make();
    for (let index = 0; index < 3; index += 1) guard.recordOutcome('failed');
    advance(10_000);
    const decisions = await Promise.all(Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => guard.canAttempt())));
    assert.equal(decisions.filter((decision) => decision.allowed).length, 1);
    assert.equal(decisions[0].probe, true);
    assert.equal(guard.recordOutcome(outcome).event, 'recovery');
    assert.equal(guard.snapshot().state, 'closed');
  }
});

test('failed or timed-out half-open probes reopen for another cooldown', () => {
  for (const outcome of ['failed', 'timeout']) {
    const { guard, advance } = make();
    for (let index = 0; index < 3; index += 1) guard.recordOutcome('failed');
    advance(10_000);
    assert.equal(guard.canAttempt().allowed, true);
    assert.equal(guard.recordOutcome(outcome).event, 'open');
    assert.equal(guard.canAttempt().allowed, false);
  }
});

test('a cancelled half-open probe releases ownership without opening the guard', () => {
  const { guard, advance } = make();
  for (let index = 0; index < 3; index += 1) guard.recordOutcome('failed');
  advance(10_000);
  assert.equal(guard.canAttempt().probe, true);
  guard.cancelAttempt();
  assert.deepEqual(guard.canAttempt(), { allowed: true, state: 'half_open', probe: true });
});
test('snapshot and configuration remain bounded and identity-free', () => {
  const { guard } = make();
  guard.recordOutcome('accepted');
  assert.doesNotMatch(JSON.stringify(guard.snapshot()),
    /https?:|Authorization|Cookie|Referer|Origin|token|title|contentId|tmdbId|email|user/i);
  assert.throws(() => createPrimaryRuntimeGuard({ minimumAttempts: 2 }),
    /PRIMARY_GUARD_INVALID_CONFIG/);
});
