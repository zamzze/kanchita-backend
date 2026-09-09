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
delete process.env.STREAM_RESOLVER_V2_PRIMARY_ENABLED;
delete process.env.STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS;
delete process.env.STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED;
delete process.env.STREAM_RESOLVER_V2_HTTP_PROVIDER_BASE_URL;
delete process.env.STREAM_RESOLVER_V2_HTTP_PROVIDER_TIMEOUT_MS;
delete process.env.STREAM_RESOLVER_V2_HTTP_PROVIDER_MAX_CANDIDATES;
delete process.env.STREAM_RESOLVER_V2_HTTP_RESOLVER_ENABLED;
delete process.env.STREAM_RESOLVER_V2_HTTP_RESOLVER_DOMAINS;
delete process.env.STREAM_RESOLVER_V2_HTTP_RESOLVER_TIMEOUT_MS;
delete process.env.STREAM_RESOLVER_V2_HTTP_RESOLVER_MAX_STREAMS;
delete process.env.STREAM_RESOLVER_V2_HEALTH_ENABLED;
delete process.env.STREAM_RESOLVER_V2_FAILURE_THRESHOLD;
delete process.env.STREAM_RESOLVER_V2_COOLDOWN_SECONDS;
delete process.env.STREAM_RESOLVER_V2_HALF_OPEN_SUCCESS_THRESHOLD;

const env = require('../src/config/env');

test('shadow feature flag is false by default and exact-true only', () => {
  assert.equal(env.STREAM_RESOLVER_V2_SHADOW_ENABLED, false);
  for (const [value, expected] of [[undefined, false], ['false', false], ['TRUE', false],
    ['1', false], ['true', true]]) {
    assert.equal(env.isExplicitlyEnabled(value), expected);
  }
});

test('primary feature flag and timeout are strict and independently bounded', () => {
  assert.equal(env.STREAM_RESOLVER_V2_PRIMARY_ENABLED, false);
  assert.equal(env.STREAM_RESOLVER_V2_PRIMARY_TIMEOUT_MS, 5000);
  for (const [value, expected] of [['500', 500], ['15000', 15000], ['499', 5000],
    ['15001', 5000], ['bad', 5000], ['', 5000]]) {
    process.env.PRIMARY_TIMEOUT_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('PRIMARY_TIMEOUT_FIXTURE', 5000, 500, 15_000),
      expected);
  }
  delete process.env.PRIMARY_TIMEOUT_FIXTURE;
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

test('configured HTTP source defaults are disabled and bounded', () => {
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED, false);
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_PROVIDER_ID, 'provider_a');
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_PROVIDER_BASE_URL, '');
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_PROVIDER_TIMEOUT_MS, 2000);
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_PROVIDER_MAX_CANDIDATES, 8);
  assert.equal(env.isExplicitlyEnabled('1'), false);
  for (const [value, expected] of [['100', 100], ['10000', 10000], ['99', 2000],
    ['10001', 2000], ['bad', 2000]]) {
    process.env.HTTP_TIMEOUT_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('HTTP_TIMEOUT_FIXTURE', 2000, 100, 10_000),
      expected);
  }
  for (const [value, expected] of [['1', 1], ['32', 32], ['0', 8], ['33', 8]]) {
    process.env.HTTP_CANDIDATE_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('HTTP_CANDIDATE_FIXTURE', 8, 1, 32), expected);
  }
  delete process.env.HTTP_TIMEOUT_FIXTURE;
  delete process.env.HTTP_CANDIDATE_FIXTURE;
});

test('configured HTTP resolver defaults are disabled and bounded', () => {
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_RESOLVER_ENABLED, false);
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_RESOLVER_ID, 'resolver_a');
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_RESOLVER_DOMAINS, '');
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_RESOLVER_TIMEOUT_MS, 2000);
  assert.equal(env.STREAM_RESOLVER_V2_HTTP_RESOLVER_MAX_STREAMS, 4);
  for (const [value, expected] of [['100', 100], ['10000', 10000], ['99', 2000], ['10001', 2000]]) {
    process.env.RESOLVER_TIMEOUT_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('RESOLVER_TIMEOUT_FIXTURE', 2000, 100, 10_000), expected);
  }
  for (const [value, expected] of [['1', 1], ['16', 16], ['0', 4], ['17', 4]]) {
    process.env.RESOLVER_STREAM_FIXTURE = value;
    assert.equal(env.boundedPositiveInteger('RESOLVER_STREAM_FIXTURE', 4, 1, 16), expected);
  }
  delete process.env.RESOLVER_TIMEOUT_FIXTURE;
  delete process.env.RESOLVER_STREAM_FIXTURE;
});

test('V2 health defaults enabled with independent bounded settings', () => {
  assert.equal(env.STREAM_RESOLVER_V2_HEALTH_ENABLED, true);
  assert.equal(env.STREAM_RESOLVER_V2_FAILURE_THRESHOLD, 5);
  assert.equal(env.STREAM_RESOLVER_V2_COOLDOWN_SECONDS, 300);
  assert.equal(env.STREAM_RESOLVER_V2_HALF_OPEN_SUCCESS_THRESHOLD, 1);
  assert.equal(env.isExplicitlyEnabled('false'), false);
  assert.equal(env.isExplicitlyEnabled('TRUE'), false);
  for (const [name, fallback, minimum, maximum] of [
    ['HEALTH_FAILURE_FIXTURE', 5, 1, 20],
    ['HEALTH_COOLDOWN_FIXTURE', 300, 1, 3600],
    ['HEALTH_SUCCESS_FIXTURE', 1, 1, 5],
  ]) {
    process.env[name] = String(minimum);
    assert.equal(env.boundedPositiveInteger(name, fallback, minimum, maximum), minimum);
    process.env[name] = String(maximum);
    assert.equal(env.boundedPositiveInteger(name, fallback, minimum, maximum), maximum);
    process.env[name] = String(maximum + 1);
    assert.equal(env.boundedPositiveInteger(name, fallback, minimum, maximum), fallback);
    delete process.env[name];
  }
});