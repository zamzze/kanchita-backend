'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStreamRanker } =
  require('../src/modules/streams/resolverV2/ranking/streamRanker');
const { createPrimaryResolver } =
  require('../src/modules/streams/resolverV2/primaryResolver');
const { createPrimaryStats } =
  require('../src/modules/streams/resolverV2/observability/primaryStats');
const { selectResolutionMode } =
  require('../src/modules/streams/resolverV2/resolutionMode');

const media = { contentType: 'movie', contentId: 'fixture', tmdbId: 1, title: 'Fixture' };
const stream = (overrides = {}) => ({
  url: 'https://media.example.test/master.m3u8', protocol: 'hls', providerId: 'source',
  resolverId: 'direct_hls', headers: {}, validated: true, quality: '720p',
  audioLanguage: 'es-419', subtitleLanguage: null, expiresAt: null, latencyMs: 1,
  hlsInfo: null, metadata: { resolverStrategy: 'direct' }, ...overrides,
});
const make = (resolve, options = {}) => createPrimaryResolver({
  pipeline: { resolve }, ranker: createStreamRanker(), enabled: true, timeoutMs: 500,
  logger: { log: () => {} }, ...options,
});

test('mode selector makes primary dominant and preserves shadow/legacy combinations', () => {
  assert.equal(selectResolutionMode({ primaryEnabled: true, shadowEnabled: false }), 'primary');
  assert.equal(selectResolutionMode({ primaryEnabled: true, shadowEnabled: true }), 'primary');
  assert.equal(selectResolutionMode({ primaryEnabled: false, shadowEnabled: true }), 'shadow');
  assert.equal(selectResolutionMode({ primaryEnabled: false, shadowEnabled: false }), 'legacy');
});

test('primary ranks pipeline streams and returns only an accepted selection', async () => {
  const resolver = make(async () => ({ streams: [
    stream({ url: 'https://media.example.test/en.m3u8', quality: '1080p', audioLanguage: 'en' }),
    stream({ url: 'https://media.example.test/lat.m3u8', quality: '720p' }),
  ] }));
  const result = await resolver.resolve(media);
  assert.equal(result.status, 'accepted');
  assert.match(result.selected.url, /lat\.m3u8$/);
  assert.equal(result.summary.selection.languageTier, 'latino');
  assert.doesNotMatch(JSON.stringify(result.summary), /https?:|headers|token|contentId|tmdbId/i);
});

test('empty, rejected and failures are stable non-throwing outcomes', async () => {
  assert.equal((await make(async () => ({ streams: [] })).resolve(media)).status, 'empty');
  assert.equal((await make(async () => ({ streams: [stream({ validated: false })] }))
    .resolve(media)).status, 'rejected');
  assert.equal((await make(async () => { throw new Error('secret URL'); }).resolve(media)).status,
    'failed');
});

test('global timeout and external abort stop waiting with distinct outcomes', async () => {
  const timeout = make(async () => new Promise(() => {}), {
    setTimer: (callback) => { queueMicrotask(callback); return { unref: () => {} }; },
    clearTimer: () => {},
  });
  assert.equal((await timeout.resolve(media)).status, 'timeout');
  const controller = new AbortController();
  controller.abort();
  const aborted = await make(async () => ({ streams: [] })).resolve(media,
    { signal: controller.signal });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.externalAbort, true);
});

test('telemetry failures cannot alter an accepted result', async () => {
  const resolver = make(async () => ({ streams: [stream()] }), {
    metrics: { increment: () => { throw new Error('metrics'); },
      observe: () => { throw new Error('metrics'); } },
    observability: { observe: () => { throw new Error('observability'); } },
    logger: { log: () => { throw new Error('logger'); } },
  });
  assert.equal((await resolver.resolve(media)).status, 'accepted');
});

test('primary stats are bounded, safe and use attempts as ratio denominator', () => {
  const stats = createPrimaryStats();
  assert.equal(stats.snapshot().acceptRate, null);
  stats.record({ status: 'accepted', code: 'PRIMARY_ACCEPTED', legacyAvoided: true });
  stats.record({ status: 'rejected', code: 'PRIMARY_HEADERS_UNSUPPORTED', fallback: true });
  const snapshot = stats.snapshot();
  assert.equal(snapshot.attempts, 2);
  assert.equal(snapshot.acceptRate, 0.5);
  assert.equal(snapshot.fallbackRate, 0.5);
  assert.equal(snapshot.legacyAvoidanceRate, 0.5);
  assert.equal(snapshot.headersUnsupported, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:|authorization|cookie|title|contentId/i);
});

test('primary modules are isolated from browser, legacy executors, DB and direct transport', () => {
  const root = path.join(__dirname, '..', 'src', 'modules', 'streams', 'resolverV2');
  for (const relative of [
    'primaryResolver.js', 'primaryAcceptanceGate.js', 'v2LegacyResultAdapter.js',
    'resolutionMode.js', path.join('observability', 'primaryStats.js'),
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source,
      /ProviderC|providerC|puppeteer|puppeteer-real-browser|browserSlots|ResolverExecutor|child_process|config\/db|streams\.queries|\bfetch\s*\(|https?\.get\s*\(/i);
  }
});