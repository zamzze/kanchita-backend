'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');

const resolver = (resolve) => ({
  descriptor: {
    id: 'result_fixture', active: true, priority: 1, protocols: ['hls'],
    domains: [], aliases: [], urlPatterns: [], requiresBrowser: false,
  },
  canResolve: () => true,
  resolve,
});

test('registry rejects null collections and invalid StreamCandidates from resolve', async () => {
  const nullResult = createResolverRegistry([resolver(async () => null)]).get('result_fixture');
  await assert.rejects(nullResult.resolve(), (error) => error.code === 'INVALID_RESOLVER_RESULT');

  const invalidCandidate = createResolverRegistry([
    resolver(async () => [{ protocol: 'hls' }]),
  ]).get('result_fixture');
  await assert.rejects(invalidCandidate.resolve(),
    (error) => error.code === 'INVALID_RESOLVER_RESULT');
});
