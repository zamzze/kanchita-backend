'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createStreamRanker } =
  require('../src/modules/streams/resolverV2/ranking/streamRanker');
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { createPreflightRunner, syntheticMediaContext } =
  require('../src/modules/streams/resolverV2/preflight/preflightRunner');

const media = Object.freeze({ contentType: 'movie', tmdbId: 550,
  title: 'PRIVATE TITLE', contentId: 'secret-content-id' });
const stream = (overrides = {}) => ({
  url: 'https://very-secret-host.example.test/private/path/master.m3u8?token=XYZ',
  protocol: 'hls', providerId: 'secret_source', resolverId: 'secret_resolver',
  headers: {}, quality: '1080p', audioLanguage: 'en', subtitleLanguage: null,
  expiresAt: null, validated: true, latencyMs: 1, hlsInfo: null,
  metadata: { sourcePriority: 100, resolverPriority: 1000, resolverStrategy: 'direct' },
  ...overrides,
});
const sourceTrace = (overrides = {}) => ({
  providersAttempted: 1, providersSucceeded: 1, providersFailed: 0,
  providersTimedOut: 0, providersCircuitOpen: 0, candidateCount: 1,
  attempts: [{ providerId: 'secret_source', outcome: 'success', candidateCount: 1,
    durationMs: 1 }], ...overrides,
});
const resolverTrace = (overrides = {}) => ({
  attempts: [{ providerId: 'secret_source', resolverId: 'secret_resolver',
    outcome: 'resolved', durationMs: 1 }], usedLegacyFallback: false, durationMs: 1,
  ...overrides,
});
const resolved = (streams = [stream()], overrides = {}) => ({
  streams, selection: null, sourceTrace: sourceTrace(), resolverTrace: resolverTrace(),
  ...overrides,
});
const descriptors = (count) => Array.from({ length: count }, (_, index) => ({
  descriptor: { id: `component_${index}` },
}));
const makeRuntime = ({ providerCount = 1, eligibleCount = providerCount,
  resolverCount = 1, pipelineResult = resolved(), pipelineResolve, health = [],
  latency = {}, catalogSummary = { loaded: false, version: null, sourcesRegistered: 0,
    resolversRegistered: 0, sourcesSkipped: 0, resolversSkipped: 0, errorCodes: [] },
  ranker = createStreamRanker(),
} = {}) => ({
  pipeline: { resolve: pipelineResolve || (async () => pipelineResult) },
  sourceRegistry: { list: () => descriptors(providerCount),
    listForMedia: () => descriptors(eligibleCount) },
  resolverRegistry: { list: () => descriptors(resolverCount) },
  ranker,
  healthStore: { snapshot: () => health },
  observability: { snapshot: () => ({ latency, counters: {} }) },
  catalogSummary,
});
const runner = (options = {}, runnerOptions = {}) => createPreflightRunner({
  runtime: makeRuntime(options), acceptanceGate: createPrimaryAcceptanceGate(),
  ...runnerOptions,
});

test('synthetic media context supports movies and episodes without private metadata', () => {
  assert.deepEqual(syntheticMediaContext({ contentType: 'movie', tmdbId: 550 }), {
    contentType: 'movie', contentId: 'preflight:movie:550', tmdbId: 550,
    title: 'Resolver V2 preflight', season: null, episode: null,
  });
  const episode = syntheticMediaContext({ contentType: 'episode', tmdbId: 1399,
    season: 1, episode: 3 });
  assert.equal(episode.episode, 3);
  assert.equal(episode.contentId, 'preflight:episode:1399:1:3');
  assert.equal(syntheticMediaContext({ contentType: 'episode', tmdbId: 1 }), null);
  assert.equal(syntheticMediaContext({ contentType: 'movie', tmdbId: 0 }), null);
});

test('runner distinguishes invalid context, no sources, no candidates and no streams', async () => {
  assert.equal((await runner().run({})).status, 'invalid_context');
  let pipelineCalls = 0;
  const noSources = runner({ providerCount: 0, eligibleCount: 0,
    pipelineResolve: async () => { pipelineCalls += 1; } });
  assert.equal((await noSources.run(media)).status, 'no_sources');
  assert.equal(pipelineCalls, 0);
  const noCandidates = runner({ pipelineResult: resolved([], {
    sourceTrace: sourceTrace({ candidateCount: 0, providersSucceeded: 1,
      attempts: [{ outcome: 'success', candidateCount: 0 }] }),
    resolverTrace: { attempts: [], usedLegacyFallback: false, durationMs: 0 },
  }) });
  assert.equal((await noCandidates.run(media)).status, 'no_candidates');
  const noStreams = runner({ pipelineResult: resolved([], {
    sourceTrace: sourceTrace({ candidateCount: 1 }),
    resolverTrace: resolverTrace({ attempts: [{ resolverId: 'direct_hls',
      outcome: 'empty', durationMs: 1 }] }),
  }) });
  assert.equal((await noStreams.run(media)).status, 'no_streams');
});

test('real ranking and acceptance choose Latino and return no stream payload', async () => {
  const english = stream();
  const latino = stream({ url: 'https://media.example.test/latino.m3u8',
    providerId: 'other', audioLanguage: 'es-419', quality: '720p' });
  let rankCalls = 0;
  const real = createStreamRanker();
  const result = await runner({ pipelineResult: resolved([english, latino]), ranker: {
    selectBest: (...args) => { rankCalls += 1; return real.selectBest(...args); },
  } }).run(media);
  assert.equal(result.status, 'ready');
  assert.equal(rankCalls, 1);
  assert.equal(result.rankingSummary.streamCount, 2);
  assert.equal(result.rankingSummary.selected.languageTier, 'latino');
  assert.equal(result.rankingSummary.selected.qualityTier, '720p');
  assert.equal(result.acceptanceSummary.accepted, true);
  assert.equal(result.acceptanceSummary.code, 'PRIMARY_ACCEPTED');
  assert.equal(Object.hasOwn(result, 'streams'), false);
  assert.doesNotMatch(JSON.stringify(result), /very-secret-host|private\/path|XYZ|secret_source|secret_resolver|PRIVATE TITLE|secret-content|550/);
});

test('header-bound validated HLS is reported as a nontechnical rejection', async () => {
  const result = await runner({ pipelineResult: resolved([stream({
    headers: { referer: 'https://secret.example.test', cookie: 'super-secret' },
  })]) }).run(media);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.acceptanceSummary, {
    accepted: false, code: 'PRIMARY_HEADERS_UNSUPPORTED', headersSupported: false,
  });
  assert.equal(result.error.code, 'PREFLIGHT_REJECTED');
  assert.doesNotMatch(JSON.stringify(result), /referer|cookie|super-secret|secret\.example/i);
});

test('source and resolver failures coexist with later success in safe aggregates', async () => {
  const result = await runner({ providerCount: 2, resolverCount: 2,
    pipelineResult: resolved([stream()], {
      sourceTrace: sourceTrace({ providersAttempted: 2, providersSucceeded: 1,
        providersFailed: 1, attempts: [
          { providerId: 'failed_secret', outcome: 'failed', candidateCount: 0,
            errorCode: 'REMOTE_SECRET_ERROR' },
          { providerId: 'working_secret', outcome: 'success', candidateCount: 1 },
        ] }),
      resolverTrace: resolverTrace({ attempts: [
        { providerId: 'failed_secret', resolverId: 'failed_resolver', outcome: 'failed',
          errorCode: 'HTTP_CONNECTION_ERROR' },
        { providerId: 'working_secret', resolverId: 'direct_hls', outcome: 'resolved' },
      ] }),
    }) }).run(media);
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceSummary.failed, 1);
  assert.equal(result.sourceSummary.succeeded, 1);
  assert.equal(result.resolverSummary.failed, 1);
  assert.equal(result.resolverSummary.succeeded, 1);
  assert.doesNotMatch(JSON.stringify(result), /failed_secret|working_secret|REMOTE_SECRET_ERROR|HTTP_CONNECTION_ERROR/);
});

test('timeout and external abort have distinct safe outcomes and clear listeners', async () => {
  const cooperative = ({ signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('hidden'), {
      code: 'SOURCE_PROVIDER_ABORTED',
    }));
    signal.addEventListener('abort', () => reject(Object.assign(new Error('hidden'), {
      code: 'SOURCE_PROVIDER_ABORTED',
    })), { once: true });
  });
  const immediateTimer = (callback) => { callback(); return { unref: () => {} }; };
  const timeout = await runner({ pipelineResolve: cooperative }, {
    setTimer: immediateTimer, clearTimer: () => {},
  }).run(media, { timeoutMs: 1_000 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.error.code, 'PREFLIGHT_TIMEOUT');
  const controller = new AbortController();
  controller.abort();
  const aborted = await runner({ pipelineResolve: cooperative }).run(media, {
    timeoutMs: 1_000, signal: controller.signal,
  });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.error.code, 'PREFLIGHT_ABORTED');
});

test('global timeout releases the public runner even if a dependency ignores abort', async () => {
  let calls = 0;
  const neverSettles = async () => {
    calls += 1;
    return new Promise(() => {});
  };
  const immediateTimer = (callback) => { callback(); return { unref: () => {} }; };
  const result = await runner({ pipelineResolve: neverSettles }, {
    setTimer: immediateTimer, clearTimer: () => {},
  }).run(media, { timeoutMs: 1_000 });
  assert.equal(calls, 1);
  assert.equal(result.status, 'timeout');
  assert.equal(result.error.code, 'PREFLIGHT_TIMEOUT');
});

test('catalog-only is network-free and catalog failure remains safe', async () => {
  let calls = 0;
  const valid = createPreflightRunner({ runtime: makeRuntime({
    pipelineResolve: async () => { calls += 1; },
    catalogSummary: { loaded: true, version: 1, sourcesRegistered: 2,
      resolversRegistered: 3, sourcesSkipped: 1, resolversSkipped: 2,
      errorCodes: ['CATALOG_INVALID_SOURCE'] },
  }), catalogEnabled: true });
  const result = await valid.run(null, { catalogOnly: true });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 0);
  assert.deepEqual(result.catalog, { enabled: true, loaded: true, version: 1,
    sourcesRegistered: 2, resolversRegistered: 3, entriesSkipped: 3,
    errorCodes: ['CATALOG_INVALID_SOURCE'] });
  const failed = await createPreflightRunner({ runtime: makeRuntime({
    catalogSummary: { loaded: false, errorCodes: ['CATALOG_READ_FAILED'],
      path: 'C:/private/catalog.json', token: 'secret' },
  }), catalogEnabled: true }).run(null, { catalogOnly: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'PREFLIGHT_CATALOG_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /private|catalog\.json|token|secret/i);
  const disabled = await createPreflightRunner({ runtime: makeRuntime(),
    catalogEnabled: false }).run(null, { catalogOnly: true });
  assert.equal(disabled.status, 'ready');
  assert.equal(disabled.catalog.enabled, false);
});

test('health and latency snapshots are aggregated without component identity', async () => {
  const result = await runner({ health: [
    { kind: 'source', id: 'secret_source', state: 'open' },
    { kind: 'source', id: 'other_source', state: 'closed' },
    { kind: 'resolver', id: 'secret_resolver', state: 'half_open' },
  ], latency: {
    source_http: { p50: 3, p95: 5 }, resolver_http: { p50: 7, p95: 9 },
    resolver_direct: { p50: 2, p95: 2 },
  } }).run(media);
  assert.deepEqual(result.healthSummary.sources, { closed: 1, open: 1, halfOpen: 0 });
  assert.deepEqual(result.healthSummary.resolvers, { closed: 0, open: 0, halfOpen: 1 });
  assert.deepEqual(result.observabilitySummary.sourceHttpMs, { p50: 3, p95: 5 });
  assert.doesNotMatch(JSON.stringify(result), /secret_source|other_source|secret_resolver/);
});

test('runner does not mutate caller context or stream candidates', async () => {
  const input = { contentType: 'movie', tmdbId: 550, title: 'PRIVATE TITLE',
    contentId: 'secret-content-id' };
  const candidate = stream();
  const beforeInput = structuredClone(input);
  const beforeCandidate = structuredClone(candidate);
  await runner({ pipelineResult: resolved([candidate]) }).run(input);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(candidate, beforeCandidate);
});

test('unknown runtime failures are normalized without leaking their message', async () => {
  const result = await runner({ pipelineResolve: async () => {
    throw new Error('private-host.example.test/private/path/test fake-token-XYZ');
  } }).run(media);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PREFLIGHT_RUNTIME_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private-host|private\/path|fake-token/i);
});
