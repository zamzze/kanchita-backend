'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isPlaybackTransportConfigured, normalizePlaybackHeaders, playbackHeadersOrNull } =
  require('../src/modules/streams/playbackHeaders');

test('playback header contract accepts only normalized HTTP Referer and pure Origin', () => {
  assert.deepEqual(normalizePlaybackHeaders({ Referer: 'https://page.example/watch',
    ORIGIN: 'https://page.example' }), { ok: true, headers: {
    referer: 'https://page.example/watch', origin: 'https://page.example',
  } });
  assert.deepEqual(playbackHeadersOrNull(null), {});
});

test('playback transport configuration requires enablement, strong secret and safe base URL', () => {
  const configured = { enabled: true, secret: 'x'.repeat(32) };
  assert.equal(isPlaybackTransportConfigured(configured), true);
  assert.equal(isPlaybackTransportConfigured({ ...configured, enabled: false }), false);
  assert.equal(isPlaybackTransportConfigured({ ...configured, secret: 'short' }), false);
  assert.equal(isPlaybackTransportConfigured({ ...configured,
    publicBaseUrl: 'https://api.example.test' }), true);
  assert.equal(isPlaybackTransportConfigured({ ...configured,
    publicBaseUrl: 'https://user:pass@api.example.test' }), false);
});

test('playback header contract rejects unsupported, malformed and injectable values', () => {
  for (const value of [
    { cookie: 'private' }, { authorization: 'Bearer private' }, { 'user-agent': 'custom' },
    { referer: 'file:///tmp/a' }, { referer: 'https://user:pass@example.test/' },
    { referer: 'https://example.test/\r\nX-Evil: yes' },
    { origin: 'https://example.test/path' }, { origin: 'https://example.test/' },
    { origin: 'not-a-url' }, [],
  ]) assert.equal(playbackHeadersOrNull(value), null);
});
