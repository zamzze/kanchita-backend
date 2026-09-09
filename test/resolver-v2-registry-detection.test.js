'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');

const candidate = (url) => ({ providerId: 'source_a', url, headers: {} });
const resolver = (id, overrides = {}) => ({
  descriptor: {
    id, active: true, priority: 100, strategy: 'http', protocols: ['hls'],
    domains: [], aliases: [], urlPatterns: [], requiresBrowser: false, ...overrides,
  },
  canResolve: () => true,
  resolve: async () => [],
});

test('domain detection is exact, subdomain-aware and case insensitive', () => {
  const registry = createResolverRegistry([
    resolver('server', { domains: ['example.test'] }),
  ]);
  for (const url of [
    'https://example.test/item', 'https://video.example.test/item',
    'https://VIDEO.EXAMPLE.TEST/item#fragment',
  ]) {
    assert.deepEqual(registry.detect(candidate(url)).map((item) => item.descriptor.id),
      ['server']);
  }
  assert.deepEqual(registry.detect(candidate('https://fakeexample.test/item')), []);
  assert.deepEqual(registry.detect(candidate('https://different.test/item')), []);
});

test('aliases and path-prefix patterns are declarative and conjunctive', () => {
  const registry = createResolverRegistry([
    resolver('alias_only', { aliases: ['embed.example.test'], priority: 30 }),
    resolver('pattern_only', { urlPatterns: ['/resolve/'], priority: 20 }),
    resolver('both', {
      domains: ['resolver.example.test'], urlPatterns: ['/item/'], priority: 10,
    }),
  ]);
  assert.deepEqual(registry.detect(candidate('https://embed.example.test/x'))
    .map((item) => item.descriptor.id), ['alias_only']);
  assert.deepEqual(registry.detect(candidate('https://elsewhere.test/resolve/1'))
    .map((item) => item.descriptor.id), ['pattern_only']);
  assert.deepEqual(registry.detect(candidate('https://resolver.example.test/item/1'))
    .map((item) => item.descriptor.id), ['both']);
  assert.deepEqual(registry.detect(candidate('https://resolver.example.test/other')), []);
});

test('priority and ID ties remain deterministic across compatible servers', () => {
  const registry = createResolverRegistry([
    resolver('zeta', { domains: ['example.test'], priority: 50 }),
    resolver('alpha', { domains: ['example.test'], priority: 50 }),
    resolver('low', { domains: ['example.test'], priority: 1 }),
    resolver('inactive', { domains: ['example.test'], active: false, priority: 100 }),
  ]);
  assert.deepEqual(registry.detect(candidate('https://example.test/item'))
    .map((item) => item.descriptor.id), ['alpha', 'zeta', 'low']);
});

test('multiple configured resolvers are selected solely by their descriptors', () => {
  const registry = createResolverRegistry([
    resolver('resolver_a', { domains: ['a.example.test'] }),
    resolver('resolver_b', { domains: ['b.example.test'] }),
  ]);
  assert.deepEqual(registry.detect(candidate('https://a.example.test/item/1'))
    .map((item) => item.descriptor.id), ['resolver_a']);
  assert.deepEqual(registry.detect(candidate('https://b.example.test/item/1'))
    .map((item) => item.descriptor.id), ['resolver_b']);
});
test('specific server detection prevents generic direct probing collisions', () => {
  const direct = createDirectHlsResolver({
    httpClient: { get: async () => {}, head: async () => {} },
  });
  const configured = resolver('configured', {
    domains: ['resolver.example.test'], priority: 2000,
  });
  configured.canResolve = (input) => !new URL(input.url).pathname.endsWith('.m3u8');
  const registry = createResolverRegistry([direct, configured]);
  assert.deepEqual(registry.detect(candidate('https://resolver.example.test/item/1'))
    .map((item) => item.descriptor.id), ['configured']);
  assert.deepEqual(registry.detect(candidate('https://media.example.test/master.m3u8'))
    .map((item) => item.descriptor.id), ['direct_hls']);
  assert.deepEqual(registry.detect(candidate('https://resolver.example.test/master.m3u8'))
    .map((item) => item.descriptor.id), ['direct_hls']);
});

test('invalid and credential-bearing URLs fail closed without throwing', () => {
  const registry = createResolverRegistry([resolver('server', { domains: ['example.test'] })]);
  assert.deepEqual(registry.detect({ providerId: 'p', url: 'invalid', headers: {} }), []);
  assert.deepEqual(registry.detect(candidate('https://user:pass@example.test/item')), []);
});
