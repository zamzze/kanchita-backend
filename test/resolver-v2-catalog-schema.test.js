'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');

const source = (overrides = {}) => ({ id: 'source_a', type: 'configured_http',
  enabled: true, baseUrl: 'https://source.example.test/api', ...overrides });
const resolver = (overrides = {}) => ({ id: 'resolver_a', type: 'configured_http',
  enabled: true, domains: ['resolver.example.test'], pathPrefixes: ['/resolve/'],
  ...overrides });

test('version one accepts empty and missing collections only', () => {
  assert.deepEqual(normalizeCatalog({ version: 1 }).sources, []);
  assert.deepEqual(normalizeCatalog({ version: 1, sources: [], resolvers: [] }).resolvers, []);
  assert.throws(() => normalizeCatalog([]), (error) => error.code === 'CATALOG_INVALID_ROOT');
  assert.throws(() => normalizeCatalog({}), (error) => error.code === 'CATALOG_INVALID_ROOT');
  assert.throws(() => normalizeCatalog({ version: 2 }),
    (error) => error.code === 'CATALOG_UNSUPPORTED_VERSION');
  assert.throws(() => normalizeCatalog({ version: 1, sources: {} }),
    (error) => error.code === 'CATALOG_INVALID_ROOT');
});

test('source entries normalize only allowlisted configured_http fields', () => {
  const catalog = normalizeCatalog({ version: 1, sources: [source({ id: 'SOURCE_A',
    priority: 50, timeoutMs: 100, maxCandidates: 32, supportsMovies: false,
    supportsEpisodes: true, authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE_A', evil: 'x' })] });
  assert.deepEqual(catalog.sources[0], {
    id: 'source_a', type: 'configured_http', enabled: true, priority: 50,
    baseUrl: 'https://source.example.test/api', timeoutMs: 100, maxCandidates: 32,
    supportsMovies: false, supportsEpisodes: true,
    authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE_A',
  });
  assert.equal(Object.hasOwn(catalog.sources[0], 'evil'), false);
});

test('source validation skips bad types, IDs, bounds, URLs and secret references', () => {
  const entries = [source(), source({ id: 'bad id' }), source({ type: 'browser' }),
    source({ timeoutMs: 99 }), source({ timeoutMs: 10_001 }),
    source({ maxCandidates: 0 }), source({ maxCandidates: 33 }),
    source({ baseUrl: 'https://user:pass@source.example.test' }),
    source({ baseUrl: 'ftp://source.example.test' }),
    source({ authTokenEnv: 'JWT_SECRET' }), source({ headers: { Cookie: 'x' } })];
  const catalog = normalizeCatalog({ version: 1, sources: entries });
  assert.equal(catalog.sources.length, 1);
  assert.equal(catalog.summary.skippedSources, entries.length - 1);
});

test('disabled source may omit base URL while retaining safe defaults', () => {
  const entry = normalizeCatalog({ version: 1, sources: [{ id: 'source_a',
    type: 'configured_http' }] }).sources[0];
  assert.equal(entry.enabled, false);
  assert.equal(entry.baseUrl, '');
  assert.equal(entry.supportsMovies, true);
  assert.equal(entry.supportsEpisodes, true);
});

test('resolver domains, aliases and literal path prefixes normalize safely', () => {
  const entry = normalizeCatalog({ version: 1, resolvers: [resolver({
    domains: [' Resolver.Example.Test ', 'resolver.example.test'],
    aliases: ['alias.example.test'], pathPrefixes: ['/resolve/', '/embed/'],
    timeoutMs: 10_000, maxStreams: 16,
  })] }).resolvers[0];
  assert.deepEqual(entry.domains, ['resolver.example.test']);
  assert.deepEqual(entry.aliases, ['alias.example.test']);
  assert.deepEqual(entry.pathPrefixes, ['/resolve/', '/embed/']);
});

test('resolver validation rejects unsafe routing, browser and executable configuration', () => {
  const entries = [resolver(), resolver({ domains: ['https://resolver.example.test'] }),
    resolver({ domains: ['resolver.example.test/path'] }),
    resolver({ pathPrefixes: ['resolve'] }), resolver({ pathPrefixes: ['/x?y'] }),
    resolver({ pathPrefixes: ['/wild/*'] }), resolver({ timeoutMs: 99 }),
    resolver({ timeoutMs: 10_001 }), resolver({ maxStreams: 0 }),
    resolver({ maxStreams: 17 }),
    resolver({ type: 'browser' }), resolver({ requiresBrowser: true }),
    resolver({ modulePath: './evil.js' }), resolver({ script: 'evil()' }),
    resolver({ urlPatterns: ['.*'] }), resolver({ authTokenEnv: 'PATH' })];
  const catalog = normalizeCatalog({ version: 1, resolvers: entries });
  assert.equal(catalog.resolvers.length, 1);
  assert.equal(catalog.summary.skippedResolvers, entries.length - 1);
});

test('duplicates are first-valid-wins within separate namespaces', () => {
  const catalog = normalizeCatalog({ version: 1,
    sources: [source(), source({ baseUrl: 'https://other.example.test' })],
    resolvers: [resolver(), resolver({ domains: ['other.example.test'] })] });
  assert.equal(catalog.sources.length, 1);
  assert.equal(catalog.resolvers.length, 1);
  assert.deepEqual(catalog.summary.errorCodes,
    ['CATALOG_DUPLICATE_SOURCE', 'CATALOG_DUPLICATE_RESOLVER']);
});

test('structural limits reject the whole catalog and per-route overflow skips entry', () => {
  assert.throws(() => normalizeCatalog({ version: 1, sources: [source(), source({ id: 'b' })] },
    { limits: { sources: 1 } }), (error) => error.code === 'CATALOG_LIMIT_EXCEEDED');
  assert.throws(() => normalizeCatalog({ version: 1, resolvers: [
    resolver(), resolver({ id: 'resolver_b' })] }, { limits: { resolvers: 1 } }),
    (error) => error.code === 'CATALOG_LIMIT_EXCEEDED');
  const catalog = normalizeCatalog({ version: 1, resolvers: [resolver({
    domains: ['a.example.test', 'b.example.test'],
  })] }, { limits: { domains: 1 } });
  assert.equal(catalog.resolvers.length, 0);
  assert.deepEqual(catalog.summary.errorCodes, ['CATALOG_INVALID_RESOLVER']);
});

test('prototype-shaped input and dangerous own keys cannot pollute runtime objects', () => {
  assert.equal(({}).polluted, undefined);
  const malicious = JSON.parse('{"version":1,"sources":[{"id":"source_a",' +
    '"type":"configured_http","enabled":true,"baseUrl":"https://source.example.test",' +
    '"__proto__":{"polluted":true}}]}');
  const catalog = normalizeCatalog(malicious);
  assert.equal(catalog.sources.length, 0);
  assert.equal(({}).polluted, undefined);
  assert.throws(() => normalizeCatalog(Object.create({ version: 1 })),
    (error) => error.code === 'CATALOG_INVALID_ROOT');
});
