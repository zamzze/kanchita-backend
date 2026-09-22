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
const mappedWorkflow = (overrides = {}) => ({
  id: 'workflow_a', type: 'mapped_http_workflow', enabled: true, region: 'global',
  baseUrl: 'https://workflow.example.test',
  workflow: [
    { type: 'request', method: 'GET', path: '/api/{externalId}', saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json',
      path: 'streamingPlaylists.0.playlistUrl', saveAs: 'hls' },
    { type: 'emit', url: '{hls}' },
  ],
  ...overrides,
});

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

test('mapped HTTP workflow source normalizes its complete bounded contract', () => {
  const entry = normalizeCatalog({ version: 1, sources: [mappedWorkflow({
    id: 'WORKFLOW_A', region: 'GLOBAL', priority: 50, timeoutMs: 10_000,
    maxBytes: 2 * 1024 * 1024, maxRedirects: 10, maxCandidates: 32,
    maxSteps: 8, maxMappingAttempts: 8, supportsMovies: false,
    supportsEpisodes: true,
  })] }).sources[0];
  assert.equal(entry.id, 'workflow_a');
  assert.equal(entry.type, 'mapped_http_workflow');
  assert.equal(entry.region, 'global');
  assert.equal(entry.baseUrl, 'https://workflow.example.test');
  assert.equal(entry.maxSteps, 8);
  assert.equal(entry.maxMappingAttempts, 8);
  assert.equal(entry.workflow[1].path, 'streamingPlaylists.0.playlistUrl');
  assert.equal(Object.isFrozen(entry.workflow), true);
});

test('mapped workflow rejects invalid URL, region, bounds and unknown keys', () => {
  const entries = [
    mappedWorkflow({ id: 'bad_url', baseUrl: 'ftp://workflow.example.test' }),
    mappedWorkflow({ id: 'bad_region', region: 'global/path' }),
    mappedWorkflow({ id: 'attempt_zero', maxMappingAttempts: 0 }),
    mappedWorkflow({ id: 'attempt_nine', maxMappingAttempts: 9 }),
    mappedWorkflow({ id: 'step_zero', maxSteps: 0 }),
    mappedWorkflow({ id: 'step_nine', maxSteps: 9 }),
    mappedWorkflow({ id: 'unknown', unknown: true }),
  ];
  const catalog = normalizeCatalog({ version: 1, sources: entries });
  assert.equal(catalog.sources.length, 0);
  assert.equal(catalog.summary.skippedSources, entries.length);
});

test('mapped workflow remains data-only and rejects unsafe extraction paths', () => {
  const unsafeSteps = [
    { type: 'script', code: 'evil()' },
    { type: 'browser', path: '/watch' },
    { type: 'request', method: 'GET', path: '/x', saveAs: 'x',
      authorization: '{externalId}' },
  ];
  const unsafePaths = ['streamingPlaylists.*.playlistUrl',
    'streamingPlaylists[0].playlistUrl', '__proto__.playlistUrl',
    'constructor.playlistUrl', 'prototype.playlistUrl'];
  const entries = [
    ...unsafeSteps.map((step, index) => mappedWorkflow({ id: `unsafe_${index}`,
      workflow: [step] })),
    ...unsafePaths.map((path, index) => mappedWorkflow({ id: `path_${index}`,
      workflow: [
        { type: 'request', method: 'GET', path: '/api', saveAs: 'payload' },
        { type: 'extract', from: 'payload', parser: 'json', path, saveAs: 'hls' },
      ] })),
  ];
  const catalog = normalizeCatalog({ version: 1, sources: entries });
  assert.equal(catalog.sources.length, 0);
  assert.ok(catalog.summary.errorCodes.every((code) => code === 'CATALOG_INVALID_SOURCE'));
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

test('configured HTML resolver normalizes bounded nested-domain policy', () => {
  const htmlResolver = (overrides = {}) => ({ id: 'html_a', type: 'configured_html',
    enabled: true, domains: ['embed.example.test'],
    allowedMediaDomains: ['media.example.test'], ...overrides });
  const catalog = normalizeCatalog({ version: 1, resolvers: [
    htmlResolver({ allowedNestedDomains: [
      ' Nested.Example.Test ', 'nested.example.test', 'child.example.test'],
    maxNextCandidates: 8 }),
    htmlResolver({ id: 'html_default' }),
    htmlResolver({ id: 'html_minimum', maxNextCandidates: 1 }),
  ] });
  assert.deepEqual(catalog.resolvers[0].allowedNestedDomains,
    ['nested.example.test', 'child.example.test']);
  assert.equal(catalog.resolvers[0].maxNextCandidates, 8);
  assert.deepEqual(catalog.resolvers[1].allowedNestedDomains, []);
  assert.equal(catalog.resolvers[1].maxNextCandidates, 4);
  assert.equal(catalog.resolvers[2].maxNextCandidates, 1);
  assert.equal(Object.isFrozen(catalog.resolvers[0].allowedNestedDomains), true);
});

test('configured HTML resolver rejects unsafe nested domains and out-of-range fanout', () => {
  const htmlResolver = (overrides = {}) => ({ id: 'html_a', type: 'configured_html',
    enabled: true, domains: ['embed.example.test'],
    allowedMediaDomains: ['media.example.test'], ...overrides });
  const unsafe = ['*', '127.0.0.1', 'localhost', 'https://nested.example.test',
    'nested.example.test:443', 'nested.example.test/path'];
  const entries = [
    ...unsafe.map((domain, index) => htmlResolver({ id: `unsafe_${index}`,
      allowedNestedDomains: [domain] })),
    htmlResolver({ id: 'fanout_zero', maxNextCandidates: 0 }),
    htmlResolver({ id: 'fanout_nine', maxNextCandidates: 9 }),
    htmlResolver({ id: 'too_many', allowedNestedDomains: Array.from({ length: 17 },
      (_, index) => `nested-${index}.example.test`) }),
  ];
  const catalog = normalizeCatalog({ version: 1, resolvers: entries });
  assert.equal(catalog.resolvers.length, 0);
  assert.equal(catalog.summary.skippedResolvers, entries.length);
  assert.ok(catalog.summary.errorCodes.every((code) => code === 'CATALOG_INVALID_RESOLVER'));
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
