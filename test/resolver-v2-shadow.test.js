'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShadowResolver } =
  require('../src/modules/streams/resolverV2/shadowResolver');

const mediaContext = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10, title: 'Fixture',
};
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});
const metricsRecorder = () => {
  const events = [];
  return {
    events,
    metrics: {
      increment: async (name, value) => events.push(['increment', name, value]),
      observe: async (name, value) => events.push(['observe', name, value]),
    },
  };
};
const silentLogger = { log: () => {} };

test('disabled shadow has zero pipeline and telemetry overhead', async () => {
  let pipelineCalls = 0;
  const recorder = metricsRecorder();
  const shadow = createShadowResolver({
    enabled: false,
    pipeline: { resolve: async () => { pipelineCalls += 1; } },
    metrics: recorder.metrics,
    logger: silentLogger,
  });
  const result = await shadow.run(mediaContext);
  assert.equal(result.status, 'disabled');
  assert.equal(pipelineCalls, 0);
  assert.deepEqual(recorder.events, []);
});

test('success is counted while returned trace strips all sensitive fields', async () => {
  const recorder = metricsRecorder();
  const shadow = createShadowResolver({
    enabled: true,
    metrics: recorder.metrics,
    logger: silentLogger,
    pipeline: { resolve: async () => ({
      streams: [{
        url: 'https://media.example.test/x.m3u8?token=super-secret-test',
        headers: { Authorization: 'Bearer fake-secret', Cookie: 'session=fake-secret' },
      }],
      sourceTrace: {
        providersAttempted: 1, providersSucceeded: 1, candidateCount: 1,
        durationMs: 2, attempts: [{ url: 'https://secret.example.test' }],
      },
      resolverTrace: {
        attempts: [{ outcome: 'resolved', url: 'https://secret.example.test' }],
        usedLegacyFallback: false, durationMs: 3,
      },
    }) },
  });
  const result = await shadow.run(mediaContext);
  assert.equal(result.status, 'success');
  assert.equal(result.streamCount, 1);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.resolverTrace.outcomes.resolved, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized,
    /https?:|super-secret-test|fake-secret|authorization|cookie|headers|url/i);
  assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_attempt_total'));
  assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_success_total'));
  assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_duration_ms'));
});

test('empty outcomes distinguish no providers, no candidates and no streams', async () => {
  const fixtures = [
    [{ providersAttempted: 0, candidateCount: 0 }, 'no_providers'],
    [{ providersAttempted: 2, candidateCount: 0 }, 'no_candidates'],
    [{ providersAttempted: 2, candidateCount: 1 }, 'no_streams'],
  ];
  for (const [sourceTrace, expected] of fixtures) {
    const recorder = metricsRecorder();
    const shadow = createShadowResolver({
      enabled: true, metrics: recorder.metrics, logger: silentLogger,
      pipeline: { resolve: async () => ({ streams: [], sourceTrace, resolverTrace: {} }) },
    });
    const result = await shadow.run(mediaContext);
    assert.equal(result.status, expected);
    assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_empty_total'));
  }
});

test('sync throw, rejection and invalid output become failed without escaping', async () => {
  for (const resolve of [
    () => { throw new Error('token=hidden'); },
    async () => { throw new Error('rejected'); },
    async () => null,
    async () => ({ streams: [] }),
  ]) {
    const recorder = metricsRecorder();
    const shadow = createShadowResolver({ enabled: true, pipeline: { resolve },
      metrics: recorder.metrics, logger: silentLogger });
    const result = await shadow.run(mediaContext);
    assert.equal(result.status, 'failed');
    assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_failure_total'));
  }
});

test('strict timeout cuts waiting even when pipeline ignores AbortSignal', async () => {
  const recorder = metricsRecorder();
  const startedAt = Date.now();
  const shadow = createShadowResolver({
    enabled: true, timeoutMs: 100, metrics: recorder.metrics, logger: silentLogger,
    pipeline: { resolve: async () => new Promise(() => {}) },
  });
  const result = await shadow.run(mediaContext);
  assert.equal(result.status, 'timeout');
  assert.ok(Date.now() - startedAt < 250);
  assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_timeout_total'));
  assert.ok(recorder.events.some((event) => event[1] === 'resolver_v2_shadow_duration_ms'));
});


test('expired caller deadline skips pipeline and hanging metrics cannot block shadow', async () => {
  let pipelineCalls = 0;
  const shadow = createShadowResolver({
    enabled: true,
    metrics: {
      increment: async () => new Promise(() => {}),
      observe: async () => new Promise(() => {}),
    },
    logger: silentLogger,
    pipeline: { resolve: async () => {
      pipelineCalls += 1;
      return { streams: [], sourceTrace: {}, resolverTrace: {} };
    } },
  });
  const result = await shadow.run(mediaContext, { deadlineAt: Date.now() - 1 });
  assert.equal(result.status, 'timeout');
  assert.equal(pipelineCalls, 0);
});

test('external abort works before and during cooperative pipeline work', async () => {
  let calls = 0;
  const pre = new AbortController();
  pre.abort();
  const shadow = createShadowResolver({ enabled: true, logger: silentLogger,
    pipeline: { resolve: async () => { calls += 1; } } });
  assert.equal((await shadow.run(mediaContext, { signal: pre.signal })).status, 'aborted');
  assert.equal(calls, 0);

  const controller = new AbortController();
  const active = createShadowResolver({ enabled: true, logger: silentLogger,
    pipeline: { resolve: async (_media, options) => {
      calls += 1;
      await wait(500, options.signal);
      return { streams: [], sourceTrace: {}, resolverTrace: {} };
    } } });
  const pending = active.run(mediaContext, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).status, 'aborted');
  assert.equal(calls, 1);
});

test('telemetry and logger failures never alter the shadow result', async () => {
  const shadow = createShadowResolver({
    enabled: true,
    metrics: {
      increment: async () => { throw new Error('db unavailable'); },
      observe: async () => { throw new Error('db unavailable'); },
    },
    logger: { log: () => { throw new Error('logger unavailable'); } },
    pipeline: { resolve: async () => ({
      streams: [], sourceTrace: { providersAttempted: 0 }, resolverTrace: {},
    }) },
  });
  assert.equal((await shadow.run(mediaContext)).status, 'no_providers');
});
