'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  HARD_MAX_MAPPING_ATTEMPTS,
  createMappedSourceProviderAdapter,
} = require('../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter');
const { createHttpWorkflowSourceProvider } = require(
  '../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');

const descriptor = Object.freeze({
  id: 'workflow_a', active: true, priority: 90, supportsMovies: true,
  supportsEpisodes: true, languages: Object.freeze(['es-419']), strategy: 'http',
  timeoutMs: 3_000, maxCandidates: 8,
});
const movie = Object.freeze({ contentType: 'movie', tmdbId: 550 });
const episode = Object.freeze({ contentType: 'episode', tmdbId: 77, season: 2, episode: 4 });
const ref = (externalId, overrides = {}) => Object.freeze({
  mappingId: 1, providerId: 'workflow_a', region: 'latam', contentType: 'movie',
  tmdbId: 550, externalId, seasonNumber: null, episodeNumber: null,
  providerTitle: null, providerSlug: null, matchMethod: 'manual', matchConfidence: 100,
  metadata: Object.freeze({}), lastVerifiedAt: null, ...overrides,
});
const candidate = (url = 'https://media.example.test/master.m3u8') =>
  Object.freeze({ providerId: 'workflow_a', url });
const provider = (getSources) => Object.freeze({ descriptor, getSources });
const resolver = (resolve) => Object.freeze({ resolve });
const make = (options = {}) => createMappedSourceProviderAdapter({
  provider: provider(async () => []), mappingResolver: resolver(async () => []),
  region: 'latam', ...options,
});
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;

test('movie with one mapping returns the wrapped provider result', async () => {
  const expected = Object.freeze([candidate()]);
  const adapter = make({ provider: provider(async () => expected),
    mappingResolver: resolver(async () => [ref('movie-a')]) });
  assert.equal(await adapter.getSources(movie), expected);
});

test('episode with one mapping passes episode identity through', async () => {
  const episodeRef = ref('episode-a', { contentType: 'episode', tmdbId: 77,
    seasonNumber: 2, episodeNumber: 4 });
  let received;
  const adapter = make({ provider: provider(async (mediaContext, runtime) => {
    received = { mediaContext, mapping: runtime.providerMediaRef };
    return [candidate()];
  }), mappingResolver: resolver(async () => [episodeRef]) });
  assert.equal((await adapter.getSources(episode)).length, 1);
  assert.equal(received.mediaContext, episode);
  assert.equal(received.mapping, episodeRef);
});

test('no mappings returns empty without calling the provider', async () => {
  let calls = 0;
  const adapter = make({ provider: provider(async () => { calls += 1; return []; }) });
  assert.deepEqual(await adapter.getSources(movie), []);
  assert.equal(calls, 0);
});

test('mapping misses continue sequentially until the first success', async () => {
  const calls = [];
  const refs = [ref('a'), ref('b'), ref('c')];
  const adapter = make({ mappingResolver: resolver(async () => refs),
    provider: provider(async (_media, runtime) => {
      calls.push(runtime.providerMediaRef.externalId);
      return runtime.providerMediaRef.externalId === 'b' ? [candidate()] : [];
    }) });
  assert.equal((await adapter.getSources(movie)).length, 1);
  assert.deepEqual(calls, ['a', 'b']);
});

test('first successful mapping prevents later provider calls', async () => {
  const calls = [];
  const adapter = make({ mappingResolver: resolver(async () => [ref('a'), ref('b')]),
    provider: provider(async (_media, runtime) => {
      calls.push(runtime.providerMediaRef.externalId);
      return [candidate()];
    }) });
  await adapter.getSources(movie);
  assert.deepEqual(calls, ['a']);
});

test('mapping order is preserved without JavaScript reordering', async () => {
  const calls = [];
  const adapter = make({ mappingResolver: resolver(async () => [ref('z'), ref('a'), ref('m')]),
    provider: provider(async (_media, runtime) => {
      calls.push(runtime.providerMediaRef.externalId);
      return [];
    }) });
  await adapter.getSources(movie);
  assert.deepEqual(calls, ['z', 'a', 'm']);
});

test('maxMappingAttempts bounds sequential misses without mutating refs', async () => {
  const refs = Object.freeze([ref('a'), ref('b'), ref('c')]);
  const snapshot = [...refs];
  let calls = 0;
  const adapter = make({ maxMappingAttempts: 2, mappingResolver: resolver(async () => refs),
    provider: provider(async () => { calls += 1; return []; }) });
  assert.deepEqual(await adapter.getSources(movie), []);
  assert.equal(calls, 2);
  assert.deepEqual(refs, snapshot);
});

test('wrapped provider hard errors propagate without trying another mapping', async () => {
  const error = Object.assign(new Error('HTTP_TIMEOUT'), { code: 'HTTP_TIMEOUT' });
  let calls = 0;
  const adapter = make({ mappingResolver: resolver(async () => [ref('a'), ref('b')]),
    provider: provider(async () => { calls += 1; throw error; }) });
  await assert.rejects(adapter.getSources(movie), (received) => received === error);
  assert.equal(calls, 1);
});

test('mapping resolver errors propagate unchanged', async () => {
  const error = new Error('mapping unavailable');
  const adapter = make({ mappingResolver: resolver(async () => { throw error; }) });
  await assert.rejects(adapter.getSources(movie), (received) => received === error);
});

test('provider receives the exact mediaContext and ProviderMediaRef', async () => {
  const mapping = ref('exact');
  let received;
  const adapter = make({ mappingResolver: resolver(async () => [mapping]),
    provider: provider(async (mediaContext, runtime) => {
      received = { mediaContext, mapping: runtime.providerMediaRef };
      return [candidate()];
    }) });
  await adapter.getSources(movie);
  assert.equal(received.mediaContext, movie);
  assert.equal(received.mapping, mapping);
});

test('runtime, media context, refs and candidates are not mutated', async () => {
  const runtime = Object.freeze({ signal: null, marker: Object.freeze({ safe: true }) });
  const refs = Object.freeze([ref('immutable')]);
  const candidates = Object.freeze([candidate()]);
  const adapter = make({ mappingResolver: resolver(async () => refs),
    provider: provider(async (_media, receivedRuntime) => {
      assert.notEqual(receivedRuntime, runtime);
      assert.equal(receivedRuntime.marker, runtime.marker);
      return candidates;
    }) });
  assert.equal(await adapter.getSources(movie, runtime), candidates);
  assert.equal(Object.hasOwn(runtime, 'providerMediaRef'), false);
  assert.equal(Object.isFrozen(movie), true);
  assert.equal(Object.isFrozen(refs), true);
});

test('descriptor fields are normalized and preserved by the adapter', () => {
  const adapter = make();
  assert.deepEqual(adapter.descriptor, descriptor);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.descriptor), true);
});

test('invalid media identity fails closed before mapping lookup', async () => {
  let calls = 0;
  const adapter = make({ mappingResolver: resolver(async () => { calls += 1; return []; }) });
  for (const input of [null, {}, { contentType: 'movie', tmdbId: 0 },
    { contentType: 'movie', tmdbId: 1, season: 1 },
    { contentType: 'episode', tmdbId: 1, season: -1, episode: 1 }]) {
    assert.deepEqual(await adapter.getSources(input), []);
  }
  assert.equal(calls, 0);
});

test('invalid mapping resolver rejects construction', () => {
  for (const mappingResolver of [undefined, null, {}, { resolve: true }]) {
    assert.throws(() => make({ mappingResolver }),
      { code: 'MAPPED_SOURCE_PROVIDER_INVALID_MAPPING_RESOLVER' });
  }
});

test('invalid provider and conflicting explicit providerId reject construction', () => {
  for (const invalid of [undefined, {}, { descriptor }, provider(async () => null)]) {
    if (invalid?.getSources) continue;
    assert.throws(() => make({ provider: invalid }),
      { code: 'MAPPED_SOURCE_PROVIDER_INVALID_PROVIDER' });
  }
  assert.throws(() => make({ providerId: 'other' }),
    { code: 'MAPPED_SOURCE_PROVIDER_INVALID_PROVIDER_ID' });
});

test('invalid region rejects construction', () => {
  for (const region of [undefined, '', 'LAT AM', 'https://latam', 'latam/path']) {
    assert.throws(() => make({ region }), { code: 'MAPPED_SOURCE_PROVIDER_INVALID_REGION' });
  }
});

test('invalid maxMappingAttempts rejects construction', () => {
  for (const maxMappingAttempts of [0, 1.5, HARD_MAX_MAPPING_ATTEMPTS + 1, Infinity]) {
    assert.throws(() => make({ maxMappingAttempts }),
      { code: 'MAPPED_SOURCE_PROVIDER_INVALID_MAX_MAPPING_ATTEMPTS' });
  }
});

test('malformed provider collection is a hard contract error', async () => {
  const adapter = make({ mappingResolver: resolver(async () => [ref('a')]),
    provider: provider(async () => null) });
  await assert.rejects(adapter.getSources(movie),
    { code: 'MAPPED_SOURCE_PROVIDER_INVALID_RESULT' });
});

test('adapter has no network, browser, engine or global database coupling', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|\bbrowser\b|child_process|\bfetch\s*\(|http\.get|https\.get|axios|config\/db|SafeHttpClient|ProviderC|ResolverExecutor|ResolverEngine|SourceProviderManager/i);
});

test('local integration maps movie through HTTP workflow GET, extract and emit', async () => {
  const requests = [];
  const server = await listen((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    response.end('<iframe src="https://media.example.test/integration.m3u8"></iframe>');
  });
  try {
    const workflowProvider = createHttpWorkflowSourceProvider({
      id: 'workflow_a', enabled: true, baseUrl: origin(server),
      http: createSafeHttpClient({ allowPrivateNetworks: true }),
      workflow: [
        { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
        { type: 'extract', from: 'page', parser: 'html', selector: 'iframe',
          attribute: 'src', saveAs: 'streamUrl' },
        { type: 'emit', url: '{streamUrl}', qualityHint: '1080p' },
      ],
    });
    const adapter = createMappedSourceProviderAdapter({ provider: workflowProvider,
      mappingResolver: resolver(async () => [ref('mapped-550')]), region: 'latam' });
    const result = await adapter.getSources(movie);
    assert.deepEqual(requests, ['/item/mapped-550']);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://media.example.test/integration.m3u8');
    assert.equal(result[0].providerId, 'workflow_a');
  } finally { await close(server); }
});

test('local integration tries mapping B after workflow A returns an empty result', async () => {
  const requests = [];
  const server = await listen((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    response.end(request.url.endsWith('/a') ? '<p>no player</p>'
      : '<iframe src="https://media.example.test/b.m3u8"></iframe>');
  });
  try {
    const workflowProvider = createHttpWorkflowSourceProvider({
      id: 'workflow_a', enabled: true, baseUrl: origin(server),
      http: createSafeHttpClient({ allowPrivateNetworks: true }),
      workflow: [
        { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
        { type: 'extract', from: 'page', parser: 'html', selector: 'iframe',
          attribute: 'src', saveAs: 'streamUrl' },
        { type: 'emit', url: '{streamUrl}' },
      ],
    });
    const adapter = createMappedSourceProviderAdapter({ provider: workflowProvider,
      mappingResolver: resolver(async () => [ref('a'), ref('b')]), region: 'latam' });
    const result = await adapter.getSources(movie);
    assert.deepEqual(requests, ['/item/a', '/item/b']);
    assert.equal(result[0].url, 'https://media.example.test/b.m3u8');
  } finally { await close(server); }
});
