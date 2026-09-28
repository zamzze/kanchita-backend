'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');

const mediaContext = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 550, title: 'Fixture Movie',
};
const embed = (providerId = 'fixture', suffix = '') => ({
  providerId,
  url: `https://embed.example.test/play${suffix}`,
  headers: { 'X-Fixture': 'safe' },
});
const stream = (providerId, resolverId, suffix = '') => ({
  url: `https://media.example.test/${providerId}/${resolverId}${suffix}.m3u8`,
  protocol: 'hls', providerId, resolverId, headers: {}, expiresAt: null,
  latencyMs: 1, validated: true, quality: null, audioLanguage: null,
  subtitleLanguage: null, hlsInfo: { isHls: true }, metadata: null,
});
const resolver = (id, priority, resolve, canResolve = () => true) => ({
  descriptor: {
    id, active: true, priority, protocols: ['hls'], domains: [], aliases: [],
    urlPatterns: [], requiresBrowser: false,
  },
  canResolve,
  resolve,
});
const engine = (resolvers = [], options = {}) => createResolverEngine({
  registry: createResolverRegistry(resolvers), timeoutMs: 200, ...options,
});
const rejectsWithCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const untilAborted = (context) => new Promise((resolve, reject) => {
  if (context.signal.aborted) return reject(context.signal.reason);
  context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
});

test('engine validates media, candidates and finite configuration', async () => {
  const empty = engine();
  await rejectsWithCode(empty.resolve({ mediaContext: {}, candidates: [] }),
    'RESOLVER_ENGINE_INVALID_INPUT');
  await rejectsWithCode(empty.resolve({ mediaContext, candidates: null }),
    'RESOLVER_ENGINE_INVALID_INPUT');
  await rejectsWithCode(empty.resolve({ mediaContext, candidates: [embed(), null] }),
    'RESOLVER_ENGINE_INVALID_INPUT');
  assert.throws(() => engine([], { maxStreams: Infinity }),
    (error) => error.code === 'RESOLVER_ENGINE_INVALID_INPUT');
  assert.throws(() => engine([], { maxStreams: 0 }),
    (error) => error.code === 'RESOLVER_ENGINE_INVALID_INPUT');
});

test('empty input and registry produce deterministic empty/not-applicable results', async () => {
  const emptyInput = await engine().resolve({ mediaContext, candidates: [] });
  assert.deepEqual(emptyInput.streams, []);
  assert.deepEqual(emptyInput.attempts, []);
  assert.equal(emptyInput.usedLegacyFallback, false);
  assert.ok(emptyInput.durationMs >= 0);

  const noResolver = await engine().resolve({ mediaContext, candidates: [embed()] });
  assert.deepEqual(noResolver.streams, []);
  assert.deepEqual(noResolver.attempts.map(({ providerId, resolverId, outcome }) => ({
    providerId, resolverId, outcome,
  })), [{ providerId: 'fixture', resolverId: null, outcome: 'not_applicable' }]);
});

test('candidate, resolver priority and resolver result order are preserved', async () => {
  const low = resolver('low', 10, async (candidate) => [
    stream(candidate.providerId, 'low', '-one'), stream(candidate.providerId, 'low', '-two'),
  ]);
  const high = resolver('high', 100, async (candidate) => [stream(candidate.providerId, 'high')]);
  const result = await engine([low, high]).resolve({
    mediaContext,
    candidates: [embed('first', '/1'), embed('second', '/2')],
  });
  assert.deepEqual(result.streams.map(({ providerId, resolverId, url }) => ({
    providerId, resolverId, tail: url.split('/').pop(),
  })), [
    { providerId: 'first', resolverId: 'high', tail: 'high.m3u8' },
    { providerId: 'first', resolverId: 'low', tail: 'low-one.m3u8' },
    { providerId: 'first', resolverId: 'low', tail: 'low-two.m3u8' },
    { providerId: 'second', resolverId: 'high', tail: 'high.m3u8' },
    { providerId: 'second', resolverId: 'low', tail: 'low-one.m3u8' },
    { providerId: 'second', resolverId: 'low', tail: 'low-two.m3u8' },
  ]);
  assert.deepEqual(result.attempts.map(({ resolverId, outcome }) => ({ resolverId, outcome })), [
    { resolverId: 'high', outcome: 'resolved' },
    { resolverId: 'low', outcome: 'resolved' },
    { resolverId: 'high', outcome: 'resolved' },
    { resolverId: 'low', outcome: 'resolved' },
  ]);
  assert.ok(result.attempts.every(({ durationMs }) => durationMs >= 0));
});

test('maxStreams truncates results and prevents later work', async () => {
  let laterCalls = 0;
  let legacyCalls = 0;
  const first = resolver('first', 100, async () => [
    stream('fixture', 'first', '-1'), stream('fixture', 'first', '-2'),
    stream('fixture', 'first', '-3'),
  ]);
  const later = resolver('later', 1, async () => {
    laterCalls += 1;
    return [stream('fixture', 'later')];
  });
  const result = await engine([later, first], {
    maxStreams: 2,
    legacyFallback: { resolve: async () => { legacyCalls += 1; return []; } },
  }).resolve({
    mediaContext, candidates: [embed()],
  });
  assert.equal(result.streams.length, 2);
  assert.equal(laterCalls, 0);
  assert.equal(legacyCalls, 0);
  assert.equal(result.usedLegacyFallback, false);
  assert.deepEqual(result.attempts.map(({ resolverId }) => resolverId), ['first']);
});

test('operational resolver failures are traced safely and later success continues', async () => {
  const failing = (id, priority, code) => resolver(id, priority, async () => {
    throw Object.assign(new Error('https://secret.example.test/file.m3u8?token=hidden'), { code });
  });
  const success = resolver('success', 1, async () => [stream('fixture', 'success')]);
  const result = await engine([
    failing('timeout', 100, 'HTTP_TIMEOUT'),
    failing('connection', 90, 'HTTP_CONNECTION_ERROR'),
    success,
  ]).resolve({ mediaContext, candidates: [embed()] });
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.attempts.map(({ resolverId, outcome, errorCode }) => ({
    resolverId, outcome, errorCode,
  })), [
    { resolverId: 'timeout', outcome: 'failed', errorCode: 'HTTP_TIMEOUT' },
    { resolverId: 'connection', outcome: 'failed', errorCode: 'HTTP_CONNECTION_ERROR' },
    { resolverId: 'success', outcome: 'resolved', errorCode: undefined },
  ]);
  const trace = JSON.stringify(result.attempts);
  assert.doesNotMatch(trace, /https?:|\.m3u8|token=|headers|x-fixture/i);
});

test('empty or failed root option does not prevent a later candidate', async () => {
  const attempts = [];
  const probe = resolver('probe', 10, async (candidate) => {
    attempts.push(new URL(candidate.url).pathname);
    if (candidate.url.endsWith('/empty')) return [];
    if (candidate.url.endsWith('/failed')) {
      throw Object.assign(new Error('fixture failure'), { code: 'HTTP_TIMEOUT' });
    }
    return [stream('fixture', 'probe')];
  });
  const result = await engine([probe]).resolve({ mediaContext, candidates: [
    embed('fixture', '/empty'), embed('fixture', '/failed'), embed('fixture', '/ready'),
  ] });
  assert.deepEqual(attempts, ['/play/empty', '/play/failed', '/play/ready']);
  assert.deepEqual(result.attempts.map(({ outcome }) => outcome),
    ['empty', 'failed', 'resolved']);
  assert.equal(result.streams.length, 1);
});

test('empty resolver output is traced and normalized stream output is independent', async () => {
  const result = await engine([
    resolver('empty', 10, async () => []),
    resolver('success', 1, async () => [{
      ...stream('fixture', 'success'), headers: { 'X-Test': ' value ' },
    }]),
  ]).resolve({ mediaContext, candidates: [embed()] });
  assert.deepEqual(result.attempts.map(({ outcome }) => outcome), ['empty', 'resolved']);
  assert.deepEqual(result.streams[0].headers, { 'x-test': 'value' });
});

test('global timeout aborts cooperative work and prevents later resolver/candidate calls', async () => {
  let laterResolverCalls = 0;
  let secondCandidateCalls = 0;
  const slow = resolver('slow', 100, async (_candidate, context) => untilAborted(context),
    (candidate) => {
      if (candidate.providerId === 'second') secondCandidateCalls += 1;
      return true;
    });
  const later = resolver('later', 1, async () => {
    laterResolverCalls += 1;
    return [];
  });
  await rejectsWithCode(engine([later, slow], { timeoutMs: 25 }).resolve({
    mediaContext, candidates: [embed('first'), embed('second')],
  }), 'RESOLVER_ENGINE_TIMEOUT');
  assert.equal(laterResolverCalls, 0);
  assert.equal(secondCandidateCalls, 0);
});

test('external abort is distinct from timeout and stops iteration', async () => {
  let laterCalls = 0;
  const controller = new AbortController();
  const slow = resolver('slow', 100, async (_candidate, context) => untilAborted(context));
  const later = resolver('later', 1, async () => { laterCalls += 1; return []; });
  const pending = engine([later, slow]).resolve({
    mediaContext, candidates: [embed()], signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await rejectsWithCode(pending, 'RESOLVER_ENGINE_ABORTED');
  assert.equal(laterCalls, 0);

  const preAborted = new AbortController();
  preAborted.abort();
  await rejectsWithCode(engine([later]).resolve({
    mediaContext, candidates: [embed()], signal: preAborted.signal,
  }), 'RESOLVER_ENGINE_ABORTED');
  assert.equal(laterCalls, 0);
});

test('legacy fallback runs only when V2 produced no streams', async () => {
  let legacyCalls = 0;
  const legacyFallback = {
    resolve: async () => {
      legacyCalls += 1;
      return [stream('legacy_provider', 'legacy_browser')];
    },
  };
  const success = await engine([
    resolver('v2', 1, async () => [stream('fixture', 'v2')]),
  ], { legacyFallback }).resolve({ mediaContext, candidates: [embed()] });
  assert.equal(legacyCalls, 0);
  assert.equal(success.usedLegacyFallback, false);

  const fallback = await engine([
    resolver('empty', 1, async () => []),
  ], { legacyFallback }).resolve({ mediaContext, candidates: [embed()] });
  assert.equal(legacyCalls, 1);
  assert.equal(fallback.usedLegacyFallback, true);
  assert.equal(fallback.streams[0].resolverId, 'legacy_browser');
  assert.equal(fallback.attempts.at(-1).outcome, 'resolved');
});

test('failure then V2 success skips legacy; all failures invoke it once', async () => {
  let legacyCalls = 0;
  const legacyFallback = { resolve: async () => { legacyCalls += 1; return []; } };
  const failed = resolver('failed', 100, async () => {
    throw Object.assign(new Error('fixture'), { code: 'HTTP_CONNECTION_ERROR' });
  });
  await engine([failed, resolver('success', 1, async () => [stream('p', 'success')])], {
    legacyFallback,
  }).resolve({ mediaContext, candidates: [embed()] });
  assert.equal(legacyCalls, 0);

  const result = await engine([failed], { legacyFallback }).resolve({
    mediaContext, candidates: [embed()],
  });
  assert.equal(legacyCalls, 1);
  assert.equal(result.usedLegacyFallback, true);
  assert.deepEqual(result.streams, []);
  assert.equal(result.attempts.at(-1).outcome, 'empty');
});

test('legacy operational failure is traced without exposing its message', async () => {
  const result = await engine([], {
    legacyFallback: { resolve: async () => {
      throw Object.assign(new Error('token=hidden'), { code: 'BROWSER_CAPACITY_UNAVAILABLE' });
    } },
  }).resolve({ mediaContext, candidates: [] });
  assert.equal(result.usedLegacyFallback, true);
  assert.deepEqual(result.streams, []);
  assert.deepEqual(result.attempts.map(({ resolverId, outcome, errorCode }) => ({
    resolverId, outcome, errorCode,
  })), [{
    resolverId: 'legacy_browser', outcome: 'failed', errorCode: 'BROWSER_CAPACITY_UNAVAILABLE',
  }]);
  assert.doesNotMatch(JSON.stringify(result.attempts), /token=|hidden/);
});

test('timeout or external abort prevents fallback from starting', async () => {
  let legacyCalls = 0;
  const legacyFallback = { resolve: async () => { legacyCalls += 1; return []; } };
  const slow = resolver('slow', 1, async (_candidate, context) => untilAborted(context));
  await rejectsWithCode(engine([slow], { legacyFallback, timeoutMs: 20 }).resolve({
    mediaContext, candidates: [embed()],
  }), 'RESOLVER_ENGINE_TIMEOUT');
  assert.equal(legacyCalls, 0);

  const controller = new AbortController();
  const pending = engine([slow], { legacyFallback }).resolve({
    mediaContext, candidates: [embed()], signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await rejectsWithCode(pending, 'RESOLVER_ENGINE_ABORTED');
  assert.equal(legacyCalls, 0);
});

test('same input produces the same semantic stream and attempt order', async () => {
  const resolvers = [
    resolver('b', 1, async (candidate) => [stream(candidate.providerId, 'b')]),
    resolver('a', 1, async (candidate) => [stream(candidate.providerId, 'a')]),
  ];
  const run = async () => {
    const result = await engine(resolvers).resolve({
      mediaContext, candidates: [embed('one'), embed('two')],
    });
    return {
      streams: result.streams.map(({ providerId, resolverId }) => ({ providerId, resolverId })),
      attempts: result.attempts.map(({ providerId, resolverId, outcome }) => ({
        providerId, resolverId, outcome,
      })),
    };
  };
  assert.deepEqual(await run(), await run());
});

test('engine source has no persistence, browser or production coupling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'resolverEngine.js'), 'utf8');
  assert.doesNotMatch(source, /puppeteer|ProviderC|providerC|console\.|process\.env/);
  assert.doesNotMatch(source, /streamLifecycle|resolutionQueue|streams\.service|\bpg\b|config\/db/);
});
