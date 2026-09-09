'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://shadow:shadow@127.0.0.1:5432/shadow';
process.env.JWT_SECRET ||= 'shadow-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'shadow-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'shadow-test-tmdb';
delete process.env.STREAM_RESOLVER_V2_SHADOW_ENABLED;
delete process.env.STREAM_RESOLVER_V2_SHADOW_TIMEOUT_MS;

const env = require('../src/config/env');

test('shadow feature flag is false by default and exact-true only', () => {
  assert.equal(env.STREAM_RESOLVER_V2_SHADOW_ENABLED, false);
  for (const [value, expected] of [[undefined, false], ['false', false], ['TRUE', false],
    ['1', false], ['true', true]]) {
    assert.equal(env.isExplicitlyEnabled(value), expected);
  }
});

test('shadow timeout has bounded safe defaults', () => {
  assert.equal(env.STREAM_RESOLVER_V2_SHADOW_TIMEOUT_MS, 1500);
  for (const [value, expected] of [['100', 100], ['10000', 10000], ['99', 1500],
    ['10001', 1500], ['abc', 1500], ['', 1500]]) {
    process.env.SHADOW_TIMEOUT_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('SHADOW_TIMEOUT_FIXTURE', 1500, 100, 10_000),
      expected);
  }
  delete process.env.SHADOW_TIMEOUT_FIXTURE;
});
