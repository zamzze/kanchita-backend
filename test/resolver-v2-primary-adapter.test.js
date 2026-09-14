'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ADAPTER_ERROR_CODE, adaptV2ToLegacyResult } =
  require('../src/modules/streams/resolverV2/v2LegacyResultAdapter');

const candidate = (overrides = {}) => ({
  url: 'https://media.example.test/master.m3u8', protocol: 'hls',
  providerId: 'source_a', resolverId: 'direct_hls', headers: {}, validated: true,
  quality: '1080', audioLanguage: 'es-419', subtitleLanguage: 'es',
  expiresAt: '2030-01-01T00:05:00Z', latencyMs: 1, hlsInfo: null,
  metadata: { resolverStrategy: 'direct' }, ...overrides,
});

test('accepted V2 HLS maps exactly to the existing lifecycle resolver shape', () => {
  assert.deepEqual(adaptV2ToLegacyResult(candidate()), {
    url: 'https://media.example.test/master.m3u8', provider: 'source_a', serverName: 'V2',
    strategy: 'direct', cleanliness: 'unknown', quality: '1080p', language: 'es-419',
    audioLanguage: 'es-419', subtitleLanguage: 'es',
    expiresAt: '2030-01-01T00:05:00.000Z', validated: true, playbackHeaders: {},
  });
});

test('adapter preserves only safe playback headers and rejects other unsupported streams', () => {
  assert.deepEqual(adaptV2ToLegacyResult(candidate({ headers: {
    Referer: 'https://player.example.test/watch', Origin: 'https://player.example.test',
  } })).playbackHeaders, {
    referer: 'https://player.example.test/watch', origin: 'https://player.example.test',
  });
  for (const fixture of [
    candidate({ headers: { cookie: 'private' } }),
    candidate({ protocol: 'mp4' }), candidate({ validated: false }),
    candidate({ metadata: { resolverStrategy: 'browser' } }), { invalid: true },
  ]) {
    assert.throws(() => adaptV2ToLegacyResult(fixture),
      (error) => error.code === ADAPTER_ERROR_CODE);
  }
});

test('VOSE maps to legacy language while retaining explicit audio/subtitle fields', () => {
  const result = adaptV2ToLegacyResult(candidate({
    audioLanguage: 'en', subtitleLanguage: 'es-419', quality: '720p',
  }));
  assert.equal(result.language, 'en-sub');
  assert.equal(result.audioLanguage, 'en');
  assert.equal(result.subtitleLanguage, 'es-419');
});
