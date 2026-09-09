'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  classifyLanguage, normalizeLanguage, normalizeQuality, qualityTier, createStreamRanker,
} = require('../src/modules/streams/resolverV2/ranking/streamRanker');

const stream = (id, overrides = {}) => ({
  url: `https://media.example.test/${id}.m3u8`, protocol: 'hls',
  providerId: `provider_${id}`, resolverId: `resolver_${id}`, headers: {},
  validated: true, latencyMs: 10, quality: '720p', audioLanguage: 'en',
  subtitleLanguage: null, expiresAt: null, metadata: null, hlsInfo: null, ...overrides,
});
const best = (streams, options) => createStreamRanker(options).selectBest(streams).selected;

test('language policy dominates quality within compatible validated streams', () => {
  assert.match(best([
    stream('english', { quality: '1080p' }),
    stream('latino', { quality: '480p', audioLanguage: 'es-419' }),
  ]).url, /latino/);
  assert.match(best([
    stream('english'), stream('castellano', { audioLanguage: 'es', quality: '1080p' }),
  ]).url, /castellano/);
  assert.match(best([
    stream('vo'), stream('vose', { subtitleLanguage: 'es' }),
  ]).url, /vose/);
  assert.match(best([
    stream('vose-es', { subtitleLanguage: 'es' }),
    stream('vose-lat', { subtitleLanguage: 'es-419' }),
  ]).url, /vose-lat/);
});

test('quality order is 1080, 720, auto, 480, 2160 within one language', () => {
  const ranked = createStreamRanker().rank([
    stream('4k', { quality: '2160p' }), stream('480', { quality: '480p' }),
    stream('auto', { quality: 'auto' }), stream('720', { quality: '720p' }),
    stream('1080', { quality: '1080p' }),
  ]);
  assert.deepEqual(ranked.map(({ quality }) => quality),
    ['1080p', '720p', 'auto', '480p', '2160p']);
});

test('validated, protocol, priority, latency and expiry are lexicographic', () => {
  assert.match(best([stream('valid'), stream('invalid', {
    validated: false, audioLanguage: 'es-419', quality: '1080p',
  })]).url, /valid/);
  assert.equal(best([stream('mp4', { protocol: 'mp4' }), stream('hls')]).protocol, 'hls');
  assert.match(best([
    stream('slow-high', { latencyMs: 100, metadata: { sourcePriority: 20 } }),
    stream('fast-low', { latencyMs: 1, metadata: { sourcePriority: 10 } }),
  ]).url, /slow-high/);
  assert.match(best([stream('slow', { latencyMs: 20 }), stream('fast', { latencyMs: 1 })]).url,
    /fast/);
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(best([
    stream('expired', { expiresAt: '2029-01-01T00:00:00Z' }),
    stream('live', { expiresAt: '2031-01-01T00:00:00Z' }),
  ], { now: () => now }).providerId, 'provider_live');
});

test('compatibility, protocol and descriptor priorities keep their lexicographic order', () => {
  assert.equal(best([
    stream('english-mp4', { protocol: 'mp4', quality: '1080p' }),
    stream('latino-dash', { protocol: 'dash', audioLanguage: 'es-419', quality: '720p' }),
  ]).providerId, 'provider_latino-dash');
  assert.equal(best([
    stream('dash', { protocol: 'dash' }), stream('mp4', { protocol: 'mp4' }),
  ]).protocol, 'mp4');
  assert.equal(best([
    stream('resolver-priority', { metadata: { sourcePriority: 10, resolverPriority: 100 } }),
    stream('source-priority', { metadata: { sourcePriority: 20, resolverPriority: 1 } }),
  ]).providerId, 'provider_source-priority');
  assert.equal(best([
    stream('resolver-low', { metadata: { sourcePriority: 10, resolverPriority: 1 } }),
    stream('resolver-high', { metadata: { sourcePriority: 10, resolverPriority: 2 } }),
  ]).providerId, 'provider_resolver-high');
});

test('known latency and longer expiry only break late ties', () => {
  assert.equal(best([
    stream('missing-latency', { latencyMs: null }), stream('known-latency', { latencyMs: 50 }),
  ]).providerId, 'provider_known-latency');
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(best([
    stream('near', { expiresAt: '2030-01-01T00:01:00Z' }),
    stream('far', { expiresAt: '2030-01-01T01:00:00Z' }),
  ], { now: () => now }).providerId, 'provider_far');
});
test('HLS resolution metadata overrides an untrusted quality hint', () => {
  const candidate = stream('fixture', {
    quality: '1080p', hlsInfo: { variants: [{ resolution: '1280x720' }] },
  });
  assert.equal(qualityTier(candidate), '720p');
});

test('normalization covers product language and quality aliases', () => {
  for (const value of ['es-419', 'ES-419', 'latino', 'lat', 'spanish-latam']) {
    assert.equal(normalizeLanguage(value), 'latino');
  }
  for (const value of ['es', 'es-ES', 'spa', 'castellano', 'spanish']) {
    assert.equal(normalizeLanguage(value), 'castellano');
  }
  for (const value of ['en', 'eng', 'english']) assert.equal(normalizeLanguage(value), 'english');
  assert.equal(normalizeLanguage(null), 'unknown');
  assert.equal(classifyLanguage('en', 'es').tier, 'vose');
  assert.equal(classifyLanguage(null, 'es').tier, 'unknown');
  for (const [value, expected] of [
    ['1080', '1080p'], ['1920x1080', '1080p'], ['1280x720', '720p'],
    ['854x480', '480p'], ['4k', '2160p'], ['auto', 'auto'], [null, 'unknown'],
  ]) assert.equal(normalizeQuality(value), expected);
});

test('ranking discards invalid candidates and is deterministic independent of input order', () => {
  const ranker = createStreamRanker({ now: () => 1000 });
  const a = stream('a');
  const b = stream('b');
  const first = ranker.rank([b, { invalid: true }, a]).map(({ providerId }) => providerId);
  const second = ranker.rank([a, b]).map(({ providerId }) => providerId);
  assert.deepEqual(first, second);
  const selection = ranker.selectBest([a]);
  assert.deepEqual(selection.reason, {
    languageTier: 'vo', qualityTier: '720p', protocolTier: 'hls',
    validated: true, resolverStrategy: 'unknown',
  });
  assert.doesNotMatch(JSON.stringify(selection.reason), /https?:|headers|token|provider_a/i);
});
