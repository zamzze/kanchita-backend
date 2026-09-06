'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://provider:provider@127.0.0.1:5432/provider';
process.env.JWT_SECRET ||= 'provider-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'provider-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'provider-test-tmdb-key';

const { createProviderManager } = require('../../src/modules/streams/providerManager');
const {
  languageScore,
  normalizeLanguage,
  normalizeQuality,
  streamScore,
} = require('../../src/modules/streams/streamAttributes');
const {
  inspectManifestCleanliness,
} = require('../../src/modules/streams/streamCleanlinessInspector');

const context = { contentType: 'movie', contentId: 'fixture' };
const validator = async (url) => ({
  valid: true,
  code: null,
  manifest: url.includes('ad')
    ? '#EXTM3U\n#EXT-X-CUE-OUT:30'
    : '#EXTM3U\n#EXTINF:10,\nsegment.ts',
});
const noHealth = {
  isAvailable: async () => true,
  recordSuccess: async () => {},
  recordFailure: async () => {},
};

test('provider manager prioritizes direct strategies and contains failures', async (t) => {
  await t.test('direct success avoids browser', async () => {
    let browserCalls = 0;
    const manager = createProviderManager({
      providers: [
        {
          id: 'direct_fixture', strategy: 'direct', resolve: async () => ({
            url: 'https://media.example/clean.m3u8', quality: '720p',
          }),
        },
        {
          id: 'browser_fixture', strategy: 'browser', resolve: async () => {
            browserCalls += 1;
            return { url: 'https://media.example/browser.m3u8' };
          },
        },
      ],
      validator,
      health: noHealth,
    });
    const result = await manager.resolve(context);
    assert.equal(result.provider, 'direct_fixture');
    assert.equal(browserCalls, 0);
  });

  await t.test('direct failure falls through and browser is always last', async () => {
    const calls = [];
    const manager = createProviderManager({
      providers: [
        {
          id: 'direct_fixture', strategy: 'direct', resolve: async () => {
            calls.push('direct');
            throw new Error('token=must-not-leak');
          },
        },
        {
          id: 'browser_fixture', strategy: 'browser', resolve: async () => {
            calls.push('browser');
            return { url: 'https://media.example/browser.m3u8' };
          },
        },
      ],
      validator,
      health: noHealth,
      logger: { warn: (message) => calls.push(message) },
    });
    const result = await manager.resolve(context);
    assert.equal(result.provider, 'browser_fixture');
    assert.deepEqual(calls.slice(0, 2), ['direct', '[ProviderManager] provider failed: direct_fixture']);
    assert.equal(calls[2], 'browser');
    assert.doesNotMatch(calls.join('\n'), /token=|\.m3u8/);
  });

  await t.test('circuit breaker skips provider and recovers when health allows it', async () => {
    let open = true;
    let calls = 0;
    const health = {
      ...noHealth,
      isAvailable: async () => !open,
    };
    const manager = createProviderManager({
      providers: [{
        id: 'direct_fixture', strategy: 'direct', resolve: async () => {
          calls += 1;
          return { url: 'https://media.example/clean.m3u8' };
        },
      }],
      validator,
      health,
    });
    await assert.rejects(manager.resolve(context), (error) =>
      error.code === 'RESOLUTION_FAILED');
    open = false;
    assert.equal((await manager.resolve(context)).provider, 'direct_fixture');
    assert.equal(calls, 1);
  });

  await t.test('safe HLS failure code survives without leaking the URL', async () => {
    const messages = [];
    const manager = createProviderManager({
      providers: [{
        id: 'unsafe_fixture', strategy: 'direct', resolve: async () => ({
          url: 'http://127.0.0.1/private.m3u8?token=hidden',
        }),
      }],
      validator: async () => ({ valid: false, code: 'HLS_UNSAFE_DESTINATION' }),
      health: noHealth,
      logger: { warn: (message) => messages.push(message) },
    });
    await assert.rejects(manager.resolve(context), (error) =>
      error.code === 'HLS_UNSAFE_DESTINATION');
    assert.doesNotMatch(messages.join('\n'), /127\.0\.0\.1|token=|\.m3u8/);
  });
});

test('stream ranking preserves business priority order', () => {
  assert.ok(streamScore({ cleanliness: 'clean', strategy: 'browser', quality: '480p' }) >
    streamScore({ cleanliness: 'ad_marked', strategy: 'direct', quality: '1080p',
      audioLanguage: 'es-419' }));
  assert.ok(streamScore({ cleanliness: 'clean', ready: true, strategy: 'browser' }) >
    streamScore({ cleanliness: 'clean', strategy: 'direct', audioLanguage: 'es-419' }));
  assert.ok(streamScore({ cleanliness: 'clean', strategy: 'direct', quality: '1080p' }) >
    streamScore({ cleanliness: 'clean', strategy: 'direct', quality: '720p',
      audioLanguage: 'es-419' }));
  assert.ok(languageScore({ audioLanguage: 'es-419' }) >
    languageScore({ audioLanguage: 'es' }));
  assert.equal(normalizeLanguage('es-LATAM'), 'es-419');
  assert.equal(normalizeLanguage('en-sub'), 'en');
  assert.equal(normalizeQuality('FullHD 1080'), '1080p');
});

test('cleanliness inspector only classifies and never rewrites', () => {
  const clean = '#EXTM3U\n#EXTINF:10,\nsegment.ts';
  const cue = '#EXTM3U\n#EXT-X-CUE-OUT:30\n#EXTINF:10,\nad.ts';
  const daterange = '#EXTM3U\n#EXT-X-DATERANGE:ID="ad"';
  assert.equal(inspectManifestCleanliness(clean), 'clean');
  assert.equal(inspectManifestCleanliness(cue), 'ad_marked');
  assert.equal(inspectManifestCleanliness(daterange), 'ad_marked');
  assert.equal(inspectManifestCleanliness('<html>'), 'unknown');
  assert.equal(cue.includes('#EXT-X-CUE-OUT'), true);
});
