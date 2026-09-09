'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');

const root = path.join(__dirname, '..');
const movie = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10, title: 'Fixture',
};
const episode = {
  contentType: 'episode', contentId: 'episode-fixture', tmdbId: 20,
  title: 'Series', season: 1, episode: 2,
};
const source = (url = 'https://media.example.test/master.m3u8', overrides = {}) => ({
  providerId: 'spoofed', url, referer: 'https://player.example.test/watch',
  origin: 'https://player.example.test',
  headers: { Authorization: 'Bearer fake-secret', Cookie: 'session=fake-secret' },
  languageHint: 'es-419', qualityHint: '1080p', metadata: { fixture: true },
  ...overrides,
});
const provider = (id, getSources, overrides = {}) => ({
  descriptor: {
    id, active: true, priority: 10, supportsMovies: true, supportsEpisodes: true,
    languages: [], strategy: 'static', timeoutMs: 100, maxCandidates: 10,
    ...overrides,
  },
  getSources,
});
const manager = (providers, options = {}) => createSourceProviderManager({
  registry: createSourceProviderRegistry(providers), providerTimeoutMs: 100,
  globalTimeoutMs: 250, ...options,
});
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason || Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});

test('successful providers preserve candidate fields and force provider identity', async () => {
  const result = await manager([
    provider('alpha', async (media, runtime) => {
      assert.equal(media.contentId, movie.contentId);
      assert.equal(media.tmdbId, movie.tmdbId);
      assert.equal(runtime.http, 'safe-http-fixture');
      assert.ok(runtime.deadlineAt > Date.now());
      return [source(), source('https://media.example.test/second?x=1')];
    }),
  ], { http: 'safe-http-fixture' }).getSources(movie);
  assert.equal(result.candidates.length, 2);
  const first = result.candidates[0];
  assert.equal(first.providerId, 'alpha');
  assert.equal(first.referer, 'https://player.example.test/watch');
  assert.equal(first.origin, 'https://player.example.test');
  assert.equal(first.headers.authorization, 'Bearer fake-secret');
  assert.equal(first.headers.cookie, 'session=fake-secret');
  assert.equal(first.languageHint, 'es-419');
  assert.equal(first.qualityHint, '1080p');
  assert.deepEqual(first.metadata, { fixture: true, sourcePriority: 10 });
  assert.equal(result.trace.providersSucceeded, 1);
  assert.equal(result.trace.candidateCount, 2);
});

test('provider failures, rejections and invalid results are isolated', async () => {
  const result = await manager([
    provider('throwing', () => { throw new Error('token=do-not-trace'); }, { priority: 40 }),
    provider('rejecting', async () => { throw new Error('rejected'); }, { priority: 30 }),
    provider('wrong_shape', async () => null, { priority: 20 }),
    provider('mixed', async () => [{ bad: true }, source()], { priority: 10 }),
  ]).getSources(movie);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].providerId, 'mixed');
  assert.equal(result.trace.providersFailed, 3);
  assert.equal(result.trace.providersSucceeded, 1);
  assert.equal(result.trace.attempts.at(-1).discardedCandidates, 1);
  assert.deepEqual(result.trace.attempts.slice(0, 3).map(({ errorCode }) => errorCode), [
    'SOURCE_PROVIDER_FAILED', 'SOURCE_PROVIDER_FAILED', 'SOURCE_PROVIDER_INVALID_RESULT',
  ]);
});

test('empty providers and inactive or incompatible providers are skipped', async () => {
  let calls = 0;
  const providers = [
    provider('empty', async () => []),
    provider('inactive', async () => { calls += 1; return [source()]; }, { active: false }),
    provider('episode_only', async () => { calls += 1; return [source()]; },
      { supportsMovies: false }),
  ];
  const result = await manager(providers).getSources(movie);
  assert.deepEqual(result.candidates, []);
  assert.equal(calls, 0);
  assert.equal(result.trace.providersAttempted, 1);
  assert.equal(result.trace.providersSucceeded, 1);
  assert.equal(result.trace.providersSkipped, 2);
  const none = await manager([]).getSources(movie);
  assert.equal(none.trace.providersAttempted, 0);
  assert.equal(none.trace.candidateCount, 0);

  let episodeCalls = 0;
  await manager([provider('episode', async () => { episodeCalls += 1; return []; },
    { supportsMovies: false })]).getSources(episode);
  assert.equal(episodeCalls, 1);
});

test('dedupe is conservative across queries, providers and relevant headers', async () => {
  const base = 'https://MEDIA.example.test:443/watch#fragment';
  const result = await manager([
    provider('alpha', async () => [
      source(base), source('https://media.example.test/watch'),
      source('https://media.example.test/watch?token=one'),
      source('https://media.example.test/watch?token=two'),
      source('https://media.example.test/watch', { referer: 'https://other.example.test' }),
    ], { priority: 20 }),
    provider('beta', async () => [source('https://media.example.test/watch')], { priority: 10 }),
  ]).getSources(movie);
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.candidates.map(({ providerId }) => providerId),
    ['alpha', 'alpha', 'alpha', 'alpha', 'beta']);
});

test('per-provider and global caps preserve provider priority and source order', async () => {
  let lateCalls = 0;
  const result = await manager([
    provider('high', async () => [source('https://a.example.test/1'),
      source('https://a.example.test/2'), source('https://a.example.test/3')],
    { priority: 100, maxCandidates: 2 }),
    provider('late', async () => { lateCalls += 1; return [source('https://b.example.test/1')]; },
      { priority: 1 }),
  ], { concurrency: 1, maxCandidates: 2 }).getSources(movie);
  assert.deepEqual(result.candidates.map(({ url }) => url),
    ['https://a.example.test/1', 'https://a.example.test/2']);
  assert.equal(lateCalls, 0);
  assert.equal(result.trace.providersSkipped, 1);
});

test('individual timeout does not block another provider', async () => {
  let fastCalled = false;
  const result = await manager([
    provider('slow', async (_media, runtime) => {
      await wait(100, runtime.signal);
      return [source()];
    }, { priority: 20, timeoutMs: 15 }),
    provider('fast', async () => { fastCalled = true; return [source()]; }, { priority: 10 }),
  ], { concurrency: 2 }).getSources(movie);
  assert.equal(fastCalled, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].providerId, 'fast');
  assert.equal(result.trace.providersTimedOut, 1);
  assert.equal(result.trace.attempts[0].errorCode, 'SOURCE_PROVIDER_TIMEOUT');
});

test('bounded worker pool never exceeds configured concurrency', async () => {
  let active = 0;
  let peak = 0;
  const providers = Array.from({ length: 5 }, (_, index) => provider(`provider_${index}`,
    async (_media, runtime) => {
      active += 1;
      peak = Math.max(peak, active);
      await wait(8, runtime.signal);
      active -= 1;
      return [source(`https://p${index}.example.test/master.m3u8`)];
    }, { priority: 100 - index }));
  const result = await manager(providers, { concurrency: 2 }).getSources(movie);
  assert.equal(result.candidates.length, 5);
  assert.ok(peak <= 2);
  assert.equal(peak, 2);
});

test('global deadline aborts active work and prevents launching queued providers', async () => {
  let queuedCalls = 0;
  const startedAt = Date.now();
  await assert.rejects(manager([
    provider('slow', async () => new Promise(() => {}), { priority: 20, timeoutMs: 100 }),
    provider('queued', async () => { queuedCalls += 1; return []; }, { priority: 10 }),
  ], { concurrency: 1, globalTimeoutMs: 25 }).getSources(movie),
  (error) => error.code === 'SOURCE_PROVIDER_GLOBAL_TIMEOUT');
  assert.equal(queuedCalls, 0);
  assert.ok(Date.now() - startedAt < 150);

  await assert.rejects(manager([]).getSources(movie, { deadlineAt: Date.now() - 1 }),
    (error) => error.code === 'SOURCE_PROVIDER_GLOBAL_TIMEOUT');
});

test('external abort works before and during provider execution', async () => {
  let calls = 0;
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(manager([provider('never', async () => { calls += 1; return []; })])
    .getSources(movie, { signal: preAborted.signal }),
  (error) => error.code === 'SOURCE_PROVIDER_ABORTED');
  assert.equal(calls, 0);

  const controller = new AbortController();
  const pending = manager([provider('slow', async () => new Promise(() => {}))])
    .getSources(movie, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.code === 'SOURCE_PROVIDER_ABORTED');
});

test('trace contains counts and stable codes but no source secrets', async () => {
  const result = await manager([
    provider('safe_id', async () => [source(
      'https://media.example.test/watch?token=super-secret-test'
    )]),
  ]).getSources(movie);
  const trace = JSON.stringify(result.trace);
  assert.doesNotMatch(trace, /super-secret-test|fake-secret|authorization|cookie|https?:/i);
  assert.equal(result.candidates[0].headers.authorization, 'Bearer fake-secret');
  assert.match(result.candidates[0].url, /super-secret-test/);
});

test('manager validates factory and call configuration', async () => {
  assert.throws(() => createSourceProviderManager(),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
  assert.throws(() => manager([], { concurrency: 0 }),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
  await assert.rejects(manager([]).getSources({}, {}),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
  await assert.rejects(manager([]).getSources(movie, { maxCandidates: Infinity }),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
});

test('new source modules remain isolated from browser, DB and direct transport', () => {
  for (const relative of [
    'sourceProviderRegistry.js', 'sourceProviderManager.js', 'candidateIdentity.js',
    'resolutionPipeline.js',
  ]) {
    const sourceText = fs.readFileSync(path.join(
      root, 'src', 'modules', 'streams', 'resolverV2', relative
    ), 'utf8');
    assert.doesNotMatch(sourceText,
      /require\([^\n]*providerC|providerC\.js|puppeteer|browserSlots|child_process|streams\.queries|postgres|\bfetch\s*\(|https?\.get\s*\(/i);
  }
});
