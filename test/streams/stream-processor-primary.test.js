'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://primary:primary@127.0.0.1:5432/primary';
process.env.JWT_SECRET ||= 'primary-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'primary-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'primary-test-tmdb';

const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
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
const dependencies = (overrides = {}) => ({
  db: { query: async () => { throw new Error('unexpected DB'); } },
  resolverExecutor: { shutdown: async () => {} },
  validator: async () => ({ valid: true }),
  findContent: async () => ({ tmdb_id: 1, title: 'Fixture' }),
  providerManager: { resolve: async () => legacy },
  lifecycle: {
    readUsableCache: async () => ({ streams: null }),
    resolveAndPersist: async (_type, _id, content, resolve) => resolve({
      contentType: 'movie', contentId: 'fixture', tmdbId: content.tmdb_id, title: content.title,
    }),
  },
  stats: { recordReady: async () => {} },
  logger: { log: () => {}, warn: () => {} },
  ...overrides,
});

test('legacy-only and shadow modes preserve Phase J authority', async () => {
  for (const shadowEnabled of [false, true]) {
    let shadowCalls = 0;
    let legacyCalls = 0;
    const processor = createStreamProcessor(dependencies({
      primaryEnabled: false, shadowEnabled,
      shadowResolver: { run: async () => { shadowCalls += 1;
        return { status: 'no_streams', selected: null }; } },
      providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
    }));
    assert.equal(await processor(job), legacy);
    assert.equal(shadowCalls, shadowEnabled ? 1 : 0);
    assert.equal(legacyCalls, 1);
  }
});

test('accepted primary is authoritative and suppresses shadow and legacy', async () => {
  for (const shadowEnabled of [false, true]) {
    let primaryCalls = 0;
    let shadowCalls = 0;
    let legacyCalls = 0;
    const stats = createPrimaryStats();
    const processor = createStreamProcessor(dependencies({
      primaryEnabled: true, shadowEnabled,
      primaryResolver: { resolve: async () => { primaryCalls += 1; return accepted; } },
      shadowResolver: { run: async () => { shadowCalls += 1; } },
      providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
      primaryStats: stats,
    }));
    const result = await processor(job);
    assert.equal(result.url, selected.url);
    assert.equal(result.validated, true);
    assert.equal(primaryCalls, 1);
    assert.equal(shadowCalls, 0);
    assert.equal(legacyCalls, 0);
    assert.equal(stats.snapshot().legacyAvoided, 1);
  }
});

test('every non-accepted primary outcome falls back to legacy exactly once', async () => {
  for (const status of ['empty', 'rejected', 'timeout', 'failed', 'aborted']) {
    let legacyCalls = 0;
    const processor = createStreamProcessor(dependencies({
      primaryEnabled: true,
      primaryResolver: { resolve: async () => ({ status, selected: null,
        summary: { code: status === 'rejected'
          ? 'PRIMARY_UNVALIDATED' : 'PRIMARY_NO_STREAM' }, externalAbort: false }) },
      providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
    }));
    assert.equal(await processor(job), legacy);
    assert.equal(legacyCalls, 1);
  }
});

test('adapter rejection fails closed while telemetry cannot undo safe adaptation', async () => {
  let legacyCalls = 0;
  const fallback = createStreamProcessor(dependencies({
    primaryEnabled: true, primaryResolver: { resolve: async () => accepted },
    primaryAdapter: () => { throw new Error('adapter rejected'); },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
  }));
  assert.equal(await fallback(job), legacy);
  assert.equal(legacyCalls, 1);

  const authoritative = createStreamProcessor(dependencies({
    primaryEnabled: true, primaryResolver: { resolve: async () => accepted },
    primaryStats: { record: () => { throw new Error('stats'); } },
    primaryMetrics: { increment: () => { throw new Error('metrics'); } },
  }));
  assert.equal((await authoritative(job)).url, selected.url);
});

test('refresh remains legacy and an external primary abort does not start legacy', async () => {
  let primaryCalls = 0;
  let legacyCalls = 0;
  const processor = createStreamProcessor(dependencies({
    primaryEnabled: true,
    primaryResolver: { resolve: async () => { primaryCalls += 1; return {
      status: 'aborted', selected: null, summary: { code: 'PRIMARY_UNKNOWN' },
      externalAbort: true,
    }; } },
    providerManager: { resolve: async () => { legacyCalls += 1; return legacy; } },
  }));
  assert.equal(await processor({ ...job, job_type: 'refresh' }), legacy);
  assert.equal(primaryCalls, 0);
  assert.equal(legacyCalls, 1);
  await assert.rejects(processor(job), (error) => error.code === 'RESOLUTION_ABORTED');
  assert.equal(primaryCalls, 1);
  assert.equal(legacyCalls, 1);
});

test('processor forwards an external signal and deadline to primary', async () => {
  const controller = new AbortController();
  const deadlineAt = Date.now() + 1_000;
  let receivedOptions = null;
  const processor = createStreamProcessor(dependencies({
    primaryEnabled: true,
    primaryResolver: { resolve: async (_context, options) => {
      receivedOptions = options;
      return accepted;
    } },
    lifecycle: {
      readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, _content, resolve) => resolve({
        contentType: 'movie', contentId: 'fixture', tmdbId: 1, title: 'Fixture',
        signal: controller.signal, deadlineAt,
      }),
    },
  }));
  assert.equal((await processor(job)).url, selected.url);
  assert.equal(receivedOptions.signal, controller.signal);
  assert.equal(receivedOptions.deadlineAt, deadlineAt);
});
test('legacy failure after primary fallback preserves the legacy error', async () => {
  const processor = createStreamProcessor(dependencies({
    primaryEnabled: true,
    primaryResolver: { resolve: async () => ({ status: 'empty', selected: null,
      summary: { code: 'PRIMARY_NO_STREAM' }, externalAbort: false }) },
    providerManager: { resolve: async () => {
      throw Object.assign(new Error('legacy failure'), { code: 'RESOLUTION_TIMEOUT' });
    } },
  }));
  await assert.rejects(processor(job), (error) => error.code === 'RESOLUTION_TIMEOUT');
});
