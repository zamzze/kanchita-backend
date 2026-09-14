'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PRIMARY_CODES, createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');

const now = Date.parse('2030-01-01T00:00:00Z');
const candidate = (overrides = {}) => ({
  url: 'https://media.example.test/master.m3u8', protocol: 'hls',
  providerId: 'source', resolverId: 'direct_hls', headers: {}, validated: true,
  quality: '1080p', audioLanguage: 'es-419', subtitleLanguage: null,
  expiresAt: null, latencyMs: 10, hlsInfo: null,
  metadata: { resolverStrategy: 'direct' }, ...overrides,
});
const gate = createPrimaryAcceptanceGate({ now: () => now });

test('strict gate accepts only validated headerless non-browser HLS', () => {
  assert.equal(gate.evaluate(candidate()).code, PRIMARY_CODES.ACCEPTED);
  assert.equal(gate.evaluate(candidate({ headers: {} })).accepted, true);
  assert.equal(gate.evaluate(candidate({ expiresAt: null })).accepted, true);
  assert.equal(gate.evaluate(candidate({ expiresAt: new Date(now + 60_000).toISOString() }))
    .accepted, true);
  assert.equal(gate.evaluate(candidate({ expiresAt: new Date(now + 300_000).toISOString() }))
    .accepted, true);
});

test('validation, protocol, URL and resolver strategy fail closed', () => {
  assert.equal(gate.evaluate(null).code, PRIMARY_CODES.NO_STREAM);
  assert.equal(gate.evaluate({ invalid: true }).code, PRIMARY_CODES.INVALID_STREAM);
  assert.equal(gate.evaluate(candidate({ url: 'file:///tmp/a.m3u8' })).code,
    PRIMARY_CODES.INVALID_STREAM);
  assert.equal(gate.evaluate(candidate({ url: 'https://user:pass@example.test/a.m3u8' })).code,
    PRIMARY_CODES.INVALID_STREAM);
  assert.equal(gate.evaluate(candidate({ validated: false })).code, PRIMARY_CODES.UNVALIDATED);
  for (const protocol of ['mp4', 'dash', 'unknown']) {
    assert.equal(gate.evaluate(candidate({ protocol })).code,
      PRIMARY_CODES.UNSUPPORTED_PROTOCOL);
  }
  assert.equal(gate.evaluate(candidate({ metadata: { resolverStrategy: 'browser' } })).code,
    PRIMARY_CODES.INCOMPATIBLE);
  assert.equal(gate.evaluate(candidate({ metadata: null })).code, PRIMARY_CODES.INCOMPATIBLE);
});

test('expiry margin rejects expired and less than sixty seconds', () => {
  assert.equal(gate.evaluate(candidate({ expiresAt: new Date(now).toISOString() })).code,
    PRIMARY_CODES.EXPIRED);
  for (const milliseconds of [1, 30_000, 59_000, 59_999]) {
    assert.equal(gate.evaluate(candidate({ expiresAt: new Date(now + milliseconds).toISOString() }))
      .code, PRIMARY_CODES.EXPIRING_TOO_SOON);
  }
});

test('playback headers require transport while invalid and unsupported values differ', () => {
  for (const [name, value, code] of [
    ['referer', 'https://player.example.test/watch', PRIMARY_CODES.HEADERS_UNSUPPORTED],
    ['origin', 'https://player.example.test', PRIMARY_CODES.HEADERS_UNSUPPORTED],
    ['origin', 'fixture-secret', PRIMARY_CODES.HEADERS_INVALID],
    ['cookie', 'fixture-secret', PRIMARY_CODES.HEADERS_UNSUPPORTED],
    ['authorization', 'fixture-secret', PRIMARY_CODES.HEADERS_UNSUPPORTED],
    ['user-agent', 'fixture-secret', PRIMARY_CODES.HEADERS_UNSUPPORTED],
  ]) {
    const result = gate.evaluate(candidate({ headers: { [name]: value } }));
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result.summary),
      /https?:|fixture-secret|authorization|cookie|referer|origin|token|provider|resolverId/i);
  }
  const proxyGate = createPrimaryAcceptanceGate({ now: () => now,
    playbackTransportAvailable: true });
  assert.equal(proxyGate.evaluate(candidate({ headers: {
    Referer: 'https://player.example.test/watch', Origin: 'https://player.example.test',
  } })).code, PRIMARY_CODES.ACCEPTED);
});
