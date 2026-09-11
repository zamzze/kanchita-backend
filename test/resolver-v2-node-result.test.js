'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeResolverNodeResult } =
  require('../src/modules/streams/resolverV2/resolverNodeResult');

const stream = (overrides = {}) => ({ url: 'https://media.example.test/master.m3u8',
  protocol: 'hls', providerId: 'source', resolverId: 'resolver', headers: {},
  validated: true, ...overrides });
const candidate = (overrides = {}) => ({ providerId: 'source',
  url: 'https://embed.example.test/e/1', headers: {}, ...overrides });

test('legacy arrays normalize to streams with no next candidates', () => {
  const input = [stream()];
  const result = normalizeResolverNodeResult(input);
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.nextCandidates, []);
  assert.equal(input[0].url, stream().url);
});

test('node object normalizes both collections and supports missing fields', () => {
  assert.equal(normalizeResolverNodeResult({ streams: [stream()],
    nextCandidates: [candidate()] }).nextCandidates.length, 1);
  assert.deepEqual(normalizeResolverNodeResult({}).streams, []);
  assert.deepEqual(normalizeResolverNodeResult({ streams: [stream()] }).nextCandidates, []);
  assert.deepEqual(normalizeResolverNodeResult({ nextCandidates: [candidate()] }).streams, []);
});

test('invalid entries are discarded while invalid roots fail closed', () => {
  const result = normalizeResolverNodeResult({ streams: [stream(), { bad: true }],
    nextCandidates: [candidate(), { bad: true }] });
  assert.equal(result.streams.length, 1);
  assert.equal(result.nextCandidates.length, 1);
  for (const value of [null, 'x', [], { streams: null }, { nextCandidates: {} }]) {
    if (Array.isArray(value)) continue;
    assert.equal(normalizeResolverNodeResult(value), null);
  }
});

test('metadata remains JSON-safe through existing candidate contracts', () => {
  const polluted = JSON.parse('{"nextCandidates":[{"providerId":"source",' +
    '"url":"https://embed.example.test/e","metadata":{"__proto__":{"x":1}}}]}');
  assert.equal(normalizeResolverNodeResult(polluted).nextCandidates.length, 0);
  assert.equal({}.x, undefined);
});
