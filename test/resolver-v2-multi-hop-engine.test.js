'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } = require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } = require('../src/modules/streams/resolverV2/resolverEngine');

const media = { contentType: 'movie', contentId: 'm', tmdbId: 1, title: 'Movie' };
const candidate = (host, path = '/e', overrides = {}) => ({ providerId: 'source',
  url: `https://${host}${path}`, headers: {}, ...overrides });
const stream = (name, language = 'en') => ({ url: `https://media.example.test/${name}.m3u8`,
  protocol: 'hls', providerId: 'source', resolverId: name, headers: {}, validated: true,
  audioLanguage: language, metadata: { resolverStrategy: 'http' } });
const resolver = (id, domain, node, calls) => ({ descriptor: { id, active: true,
  priority: 100, strategy: 'http', protocols: ['hls'], domains: [domain], aliases: [],
  urlPatterns: [], requiresBrowser: false }, canResolve: () => true,
resolve: async () => [], resolveNode: async (input, context) => {
  calls.push({ id, url: input.url, context }); return node(input, context); } });
const run = (resolvers, initial, options = {}) => createResolverEngine({
  registry: createResolverRegistry(resolvers), timeoutMs: 500, maxDepth: 2,
  maxResolutionNodes: 16, ...options,
}).resolve({ mediaContext: media, candidates: initial });

test('depth 0, 1 and 2 have exact non-recursive semantics', async () => {
  for (const [maxDepth, expectedCalls, expectedStreams] of [[0, 1, 0], [1, 2, 0], [2, 3, 1]]) {
    const calls = [];
    const resolvers = [
      resolver('a', 'a.example.test', () => ({ streams: [],
        nextCandidates: [candidate('b.example.test')] }), calls),
      resolver('b', 'b.example.test', () => ({ streams: [],
        nextCandidates: [candidate('c.example.test')] }), calls),
      resolver('c', 'c.example.test', () => ({ streams: [stream('final')],
        nextCandidates: [] }), calls),
    ];
    const result = await run(resolvers, [candidate('a.example.test')], { maxDepth });
    assert.equal(calls.length, expectedCalls);
    assert.equal(result.streams.length, expectedStreams);
    assert.equal(result.nodesSkippedDepth, maxDepth < 2 ? 1 : 0);
  }
});

test('self, two-node and three-node cycles execute each URL once', async () => {
  for (const edges of [
    { a: ['a'] }, { a: ['b'], b: ['a'] }, { a: ['b'], b: ['c'], c: ['a'] },
  ]) {
    const calls = [];
    const resolvers = Object.keys(edges).map((id) => resolver(id, `${id}.example.test`,
      () => ({ streams: [], nextCandidates: edges[id].map((next) =>
        candidate(`${next}.example.test`, '/e', { referer: `https://${id}.example.test/e` })) }), calls));
    const result = await run(resolvers, [candidate('a.example.test')], { maxDepth: 4 });
    assert.equal(calls.length, Object.keys(edges).length);
    assert.ok(result.nodesSkippedVisited >= 1);
  }
});

test('duplicate branches and a diamond converge deterministically', async () => {
  const calls = [];
  const resolvers = [
    resolver('a', 'a.example.test', () => ({ streams: [], nextCandidates: [
      candidate('b.example.test'), candidate('b.example.test'), candidate('c.example.test')] }), calls),
    resolver('b', 'b.example.test', () => ({ streams: [],
      nextCandidates: [candidate('d.example.test')] }), calls),
    resolver('c', 'c.example.test', () => ({ streams: [stream('c')],
      nextCandidates: [candidate('d.example.test')] }), calls),
    resolver('d', 'd.example.test', () => ({ streams: [stream('d')], nextCandidates: [] }), calls),
  ];
  const result = await run(resolvers, [candidate('a.example.test')], { maxDepth: 3 });
  assert.deepEqual(calls.map(({ id }) => id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.streams.map(({ resolverId }) => resolverId), ['c', 'd']);
  assert.equal(result.nodesSkippedVisited, 2);
});

test('node cap, no-resolver and maxStreams stop work without losing prior streams', async () => {
  const calls = [];
  const a = resolver('a', 'a.example.test', () => ({ streams: [stream('first')],
    nextCandidates: [candidate('missing.example.test'), candidate('b.example.test')] }), calls);
  const b = resolver('b', 'b.example.test', () => ({ streams: [stream('second')],
    nextCandidates: [] }), calls);
  const capped = await run([a, b], [candidate('a.example.test')], { maxStreams: 1 });
  assert.deepEqual(calls.map(({ id }) => id), ['a']);
  assert.equal(capped.streams.length, 1);
  calls.length = 0;
  const limited = await run([a, b], [candidate('a.example.test')],
    { maxStreams: 8, maxResolutionNodes: 2 });
  assert.equal(limited.nodeLimitReached, true);
  assert.equal(limited.nodesProcessed, 2);
  assert.equal(limited.nodesSkippedNoResolver, 1);
});

test('one failed or circuit-open branch does not block another branch', async () => {
  const calls = [];
  const resolvers = [
    resolver('a', 'a.example.test', () => ({ streams: [], nextCandidates: [
      candidate('b.example.test'), candidate('c.example.test')] }), calls),
    resolver('b', 'b.example.test', () => { const error = new Error('private');
      error.code = 'HTTP_TIMEOUT'; throw error; }, calls),
    resolver('c', 'c.example.test', () => ({ streams: [stream('ok')], nextCandidates: [] }), calls),
  ];
  const result = await run(resolvers, [candidate('a.example.test')]);
  assert.equal(result.streams.length, 1);
  assert.ok(result.attempts.some(({ resolverId, outcome }) => resolverId === 'b' && outcome === 'failed'));
  const healthStore = { canAttempt: (_kind, id) => id !== 'b', recordSuccess: () => {},
    recordFailure: () => {}, cancelAttempt: () => {} };
  const open = await run(resolvers, [candidate('a.example.test')], { healthStore });
  assert.equal(open.streams.length, 1);
  assert.ok(open.attempts.some(({ resolverId, outcome }) => resolverId === 'b' && outcome === 'circuit_open'));
});

test('next-only nodes are healthy and intermediate plus final streams are retained', async () => {
  const calls = [];
  const health = [];
  const healthStore = {
    canAttempt: () => true,
    recordSuccess: (_kind, id) => health.push(['success', id]),
    recordFailure: (_kind, id) => health.push(['failure', id]),
    cancelAttempt: () => {},
  };
  const resolvers = [
    resolver('a', 'a.example.test', () => ({ streams: [],
      nextCandidates: [candidate('b.example.test')] }), calls),
    resolver('b', 'b.example.test', () => ({ streams: [stream('intermediate')],
      nextCandidates: [candidate('c.example.test')] }), calls),
    resolver('c', 'c.example.test', () => ({ streams: [stream('final')],
      nextCandidates: [] }), calls),
  ];
  const result = await run(resolvers, [candidate('a.example.test')], { healthStore });
  assert.deepEqual(result.streams.map(({ resolverId }) => resolverId),
    ['intermediate', 'final']);
  assert.deepEqual(health, [['success', 'a'], ['success', 'b'], ['success', 'c']]);
});

test('all hops share one deadline and timeout stops future queued work', async () => {
  const calls = [];
  const deadlines = [];
  const waitForAbort = (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 100);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('stopped');
      error.code = 'HTTP_ABORTED';
      reject(error);
    }, { once: true });
  });
  const resolvers = [
    resolver('a', 'a.example.test', async (_input, context) => {
      deadlines.push(context.deadlineAt);
      return { streams: [], nextCandidates: [candidate('b.example.test'),
        candidate('c.example.test')] };
    }, calls),
    resolver('b', 'b.example.test', async (_input, context) => {
      deadlines.push(context.deadlineAt);
      await waitForAbort(context.signal);
      return { streams: [], nextCandidates: [] };
    }, calls),
    resolver('c', 'c.example.test', () => ({ streams: [stream('late')],
      nextCandidates: [] }), calls),
  ];
  await assert.rejects(() => run(resolvers, [candidate('a.example.test')],
    { timeoutMs: 35 }), (error) => error.code === 'RESOLVER_ENGINE_TIMEOUT');
  assert.equal(new Set(deadlines).size, 1);
  assert.deepEqual(calls.map(({ id }) => id), ['a', 'b']);
});

test('external abort during a nested node prevents remaining candidates', async () => {
  const calls = [];
  const controller = new AbortController();
  const resolvers = [
    resolver('a', 'a.example.test', () => ({ streams: [], nextCandidates: [
      candidate('b.example.test'), candidate('c.example.test')] }), calls),
    resolver('b', 'b.example.test', async (_input, context) => {
      controller.abort();
      await Promise.resolve();
      assert.equal(context.signal.aborted, true);
      return { streams: [], nextCandidates: [] };
    }, calls),
    resolver('c', 'c.example.test', () => ({ streams: [stream('never')],
      nextCandidates: [] }), calls),
  ];
  const engine = createResolverEngine({ registry: createResolverRegistry(resolvers),
    timeoutMs: 500, maxDepth: 2, maxResolutionNodes: 16 });
  await assert.rejects(() => engine.resolve({ mediaContext: media,
    candidates: [candidate('a.example.test')], signal: controller.signal }),
  (error) => error.code === 'RESOLVER_ENGINE_ABORTED');
  assert.deepEqual(calls.map(({ id }) => id), ['a', 'b']);
});

test('factory hard limits and graph trace remain safe', async () => {
  const registry = createResolverRegistry([]);
  for (const options of [{ maxDepth: -1 }, { maxDepth: 5 },
    { maxResolutionNodes: 0 }, { maxResolutionNodes: 65 }]) {
    assert.throws(() => createResolverEngine({ registry, ...options }),
      (error) => error.code === 'RESOLVER_ENGINE_INVALID_INPUT');
  }
  const result = await createResolverEngine({ registry }).resolve({
    mediaContext: media, candidates: [candidate('none.example.test')] });
  assert.equal(result.nodesProcessed, 1);
  assert.equal(result.nodesSkippedNoResolver, 1);
  assert.doesNotMatch(JSON.stringify(result), /none\.example\.test|\/e|referer|origin/i);
});
