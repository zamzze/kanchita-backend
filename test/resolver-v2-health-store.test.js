'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createV2HealthStore } =
  require('../src/modules/streams/resolverV2/health/v2HealthStore');

test('health starts closed and tracks safe success/failure statistics by kind', () => {
  let now = 1000;
  const store = createV2HealthStore({ failureThreshold: 2, cooldownMs: 100, clock: () => now });
  assert.equal(store.get('source', 'same').state, 'closed');
  assert.equal(store.canAttempt('source', 'same'), true);
  store.recordFailure('source', 'same', { durationMs: 4, errorCode: 'HTTP_TIMEOUT', timeout: true });
  assert.equal(store.get('source', 'same').state, 'closed');
  assert.equal(store.canAttempt('source', 'same'), true);
  store.recordFailure('source', 'same', { durationMs: 6, errorCode: 'token=unsafe' });
  const source = store.get('source', 'same');
  assert.equal(source.state, 'open');
  assert.equal(source.totalAttempts, 2);
  assert.equal(source.totalFailures, 2);
  assert.equal(source.totalTimeouts, 1);
  assert.equal(source.totalDurationMs, 10);
  assert.equal(source.lastErrorCode, 'COMPONENT_FAILURE');
  assert.equal(store.get('resolver', 'same').state, 'closed');
  now += 1;
});

test('cooldown permits one half-open probe and success closes the circuit', () => {
  let now = 0;
  const events = [];
  const store = createV2HealthStore({
    failureThreshold: 1, cooldownMs: 50, clock: () => now,
    onEvent: (type, kind) => events.push(`${kind}:${type}`),
  });
  store.canAttempt('resolver', 'alpha');
  store.recordFailure('resolver', 'alpha', { errorCode: 'HTTP_CONNECTION_ERROR' });
  assert.equal(store.canAttempt('resolver', 'alpha'), false);
  now = 50;
  const decisions = Array.from({ length: 20 }, () =>
    Promise.resolve().then(() => store.canAttempt('resolver', 'alpha')));
  return Promise.all(decisions).then((allowed) => {
    assert.equal(allowed.filter(Boolean).length, 1);
    assert.equal(store.get('resolver', 'alpha').state, 'half_open');
    store.recordSuccess('resolver', 'alpha', { durationMs: 2 });
    assert.equal(store.get('resolver', 'alpha').state, 'closed');
    assert.ok(events.includes('resolver:open'));
    assert.ok(events.includes('resolver:half_open_probe'));
    assert.ok(events.includes('resolver:recovery'));
  });
});

test('failed half-open probe reopens with a fresh cooldown', () => {
  let now = 0;
  const store = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10, clock: () => now });
  store.canAttempt('source', 'alpha');
  store.recordFailure('source', 'alpha', { errorCode: 'SOURCE_PROVIDER_FAILED' });
  now = 10;
  assert.equal(store.canAttempt('source', 'alpha'), true);
  store.recordFailure('source', 'alpha', { errorCode: 'SOURCE_PROVIDER_FAILED' });
  assert.equal(store.get('source', 'alpha').cooldownUntil, 20);
  assert.equal(store.canAttempt('source', 'alpha'), false);
});

test('success resets failures, cancellation releases a half-open probe and reset is isolated', () => {
  let now = 0;
  const store = createV2HealthStore({ failureThreshold: 2, cooldownMs: 10, clock: () => now });
  store.canAttempt('resolver', 'alpha');
  store.recordFailure('resolver', 'alpha', { errorCode: 'HTTP_TIMEOUT' });
  store.canAttempt('resolver', 'alpha');
  store.recordSuccess('resolver', 'alpha');
  assert.equal(store.get('resolver', 'alpha').consecutiveFailures, 0);
  store.canAttempt('resolver', 'alpha');
  store.recordFailure('resolver', 'alpha', { errorCode: 'HTTP_TIMEOUT' });
  store.canAttempt('resolver', 'alpha');
  store.recordFailure('resolver', 'alpha', { errorCode: 'HTTP_TIMEOUT' });
  now = 10;
  assert.equal(store.canAttempt('resolver', 'alpha'), true);
  store.cancelAttempt('resolver', 'alpha');
  assert.equal(store.canAttempt('resolver', 'alpha'), true);
  store.reset('resolver', 'alpha');
  assert.equal(store.get('resolver', 'alpha').totalAttempts, 0);
});

test('snapshot is deterministic, immutable and contains no sensitive payload fields', () => {
  const store = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10 });
  store.canAttempt('resolver', 'b');
  store.recordFailure('resolver', 'b', { errorCode: 'token=secret' });
  store.canAttempt('source', 'a');
  store.recordSuccess('source', 'a');
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.map(({ kind, id }) => `${kind}:${id}`), ['resolver:b', 'source:a']);
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:|authorization|cookie|token=|contentId|tmdbId/i);
  assert.throws(() => snapshot.push({}), TypeError);
});

test('invalid kinds, IDs, configuration and durations fail closed', () => {
  assert.throws(() => createV2HealthStore({ failureThreshold: 0 }),
    (error) => error.code === 'V2_HEALTH_INVALID_INPUT');
  const store = createV2HealthStore();
  assert.throws(() => store.canAttempt('other', 'alpha'));
  assert.throws(() => store.canAttempt('source', 'remote/id'));
  assert.throws(() => store.recordSuccess('source', 'alpha', { durationMs: -1 }));
});
