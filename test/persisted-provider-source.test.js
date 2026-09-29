'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://persisted:persisted@127.0.0.1:5432/persisted';
process.env.JWT_SECRET ||= 'persisted-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'persisted-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'persisted-test-tmdb';

const { createPersistedProviderSourceProvider } =
  require('../src/modules/streams/resolverV2/providers/persistedProviderSourceProvider');
const { createSafeHttpClient } =
  require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');
const { createProviderSourceStore } = require('../src/db/providerSources.queries');

const movie = Object.freeze({ contentType: 'movie', contentId: 'movie-1',
  tmdbId: 550, title: 'Fixture' });
const episode = Object.freeze({ contentType: 'episode', contentId: 'episode-1',
  tmdbId: 100, title: 'Fixture', season: 2, episode: 3 });
const ref = (context, mappingId = 1) => ({
  mappingId, providerId: 'fixture', region: 'global',
  contentType: context.contentType, tmdbId: context.tmdbId,
  seasonNumber: context.contentType === 'episode' ? context.season : null,
  episodeNumber: context.contentType === 'episode' ? context.episode : null,
});
const row = (mappingId = 1, overrides = {}) => ({
  id: crypto.randomUUID(), mapping_id: mappingId, status: 'active',
  source_type: 'direct_hls', source_url: 'https://media.example.test/master.m3u8',
  headers_json: {}, language: 'es-419', quality: '1080p', metadata: {},
  ...overrides,
});
const setup = (context, rows = [], refs = [ref(context)]) => {
  const calls = [];
  const provider = createPersistedProviderSourceProvider({
    id: 'fixture', region: 'global', enabled: true,
    mappingResolver: { resolve: async (lookup) => {
      calls.push({ type: 'mapping', lookup }); return refs;
    } },
    sourceStore: { findActiveSourcesForMapping: async (mappingId, options) => {
      calls.push({ type: 'source', mappingId, options });
      return rows.filter((item) => String(item.mapping_id) === String(mappingId));
    } },
  });
  return { provider, calls };
};

test('exact movie and episode mappings yield direct HLS candidates without HTTP', async () => {
  for (const context of [movie, episode]) {
    const source = row();
    const { provider, calls } = setup(context, [source]);
    const candidates = await provider.getSources(context);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'fixture');
    assert.equal(candidates[0].url, source.source_url);
    assert.equal(candidates[0].metadata.persistedSourceId, source.id);
    assert.equal(candidates[0].metadata.mappingId, 1);
    assert.deepEqual(calls.map((call) => call.type), ['mapping', 'source']);
    assert.equal(calls[0].lookup.mediaContext, context);
    assert.equal(calls[1].options.limit, 64);
    assert.equal(calls[1].options.sourceType, 'direct_hls');
  }
});

test('missing mapping or source is empty; wrong episode identity cannot cross content', async () => {
  assert.deepEqual(await setup(movie, [], []).provider.getSources(movie), []);
  assert.deepEqual(await setup(movie).provider.getSources(movie), []);
  const wrong = ref(episode);
  wrong.episodeNumber = 4;
  const { provider, calls } = setup(episode, [row()], [wrong]);
  assert.deepEqual(await provider.getSources(episode), []);
  assert.equal(calls.some((call) => call.type === 'source'), false);
  assert.deepEqual(await provider.getSources({ ...episode, season: 3 }), []);
});

test('malformed, disabled, unsupported, unsafe URL and header rows are skipped independently',
  async () => {
    const valid = row(1, { headers_json: { Referer: 'https://ref.example.test/watch' } });
    const rows = [
      row(1, { status: 'disabled' }),
      row(1, { source_type: 'embed' }),
      row(1, { source_url: 'file:///etc/passwd' }),
      row(1, { source_url: 'https://media.example.test/x.m3u8?token=private' }),
      row(1, { headers_json: { Cookie: 'private' } }),
      row(1, { headers_json: { 'User-Agent': 'fixture' } }),
      row(1, { metadata: { sessionToken: 'private' } }),
      row(2),
      valid,
    ];
    const originalHeaders = { ...valid.headers_json };
    const candidates = await setup(movie, rows).provider.getSources(movie);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].headers, { referer: originalHeaders.Referer });
    assert.deepEqual(valid.headers_json, originalHeaders);
  });

test('multiple mappings and sources keep stable order and meaningful variants', async () => {
  const first = row(1, { headers_json: { referer: 'https://ref.example.test/a' } });
  const duplicate = row(1, { headers_json: { referer: 'https://ref.example.test/a' } });
  const alternate = row(1, { headers_json: { referer: 'https://ref.example.test/b' } });
  const secondVariant = row(1, { headers_json: { referer: 'https://ref.example.test/a' },
    metadata: { variant: '2' } });
  const otherMetadata = row(2, { metadata: { variant: 'second', source: 'fixture' } });
  const redundantMetadata = row(1, { headers_json: { referer: 'https://ref.example.test/a' },
    metadata: { editorialNote: 'irrelevant' } });
  const { provider } = setup(movie,
    [first, duplicate, alternate, secondVariant, otherMetadata, redundantMetadata],
    [ref(movie, 1), ref(movie, 2)]);
  const candidates = await provider.getSources(movie);
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((candidate) => candidate.metadata.persistedSourceId),
    [first.id, alternate.id, secondVariant.id, otherMetadata.id]);
  assert.deepEqual(candidates.map((candidate) => candidate.headers.referer),
    ['https://ref.example.test/a', 'https://ref.example.test/b',
      'https://ref.example.test/a', undefined]);
  assert.equal(candidates[2].metadata.variant, '2');
  assert.equal(candidates[3].metadata.variant, 'second');
  assert.equal(candidates[3].metadata.source, 'fixture');
});

test('catalog is opt-in and rejects malformed persisted-source configuration', () => {
  const valid = { id: 'FIXTURE', type: 'persisted_sources', enabled: true,
    region: 'GLOBAL', maxCandidates: 32, maxMappingAttempts: 8 };
  const catalog = normalizeCatalog({ version: 1, sources: [valid] });
  assert.equal(catalog.sources[0].id, 'fixture');
  assert.equal(catalog.sources[0].region, 'global');
  assert.equal(catalog.sources[0].maxMappingAttempts, 8);
  const bad = [ { ...valid, region: '' }, { ...valid, region: 'global/path' },
    { ...valid, maxMappingAttempts: 9 }, { ...valid, headers: { Cookie: 'x' } },
    { ...valid, browser: true }, { ...valid, baseUrl: 'https://example.test' } ];
  assert.equal(normalizeCatalog({ version: 1, sources: bad }).sources.length, 0);
  assert.equal(normalizeCatalog({ version: 1, sources: [{ ...valid,
    enabled: false }] }).sources[0].enabled, false);
});

test('source store applies a parameterized bound only when requested', async () => {
  const calls = [];
  const store = createProviderSourceStore({ query: async (sql, values) => {
    calls.push({ sql, values }); return { rows: [] };
  } });
  assert.deepEqual(await store.findActiveSourcesForMapping(1), []);
  assert.doesNotMatch(calls[0].sql, /LIMIT/);
  assert.deepEqual(calls[0].values, [1]);
  await store.findActiveSourcesForMapping(1, { limit: 32 });
  assert.match(calls[1].sql, /LIMIT \$2/);
  assert.deepEqual(calls[1].values, [1, 32]);
  await store.findActiveSourcesForMapping(1, { sourceType: 'direct_hls', limit: 32 });
  assert.match(calls[2].sql, /source_type = \$2/);
  assert.match(calls[2].sql, /LIMIT \$3/);
  assert.deepEqual(calls[2].values, [1, 'direct_hls', 32]);
  await assert.rejects(store.findActiveSourcesForMapping(1, { limit: 65 }),
    { code: 'PROVIDER_SOURCE_INVALID_LIMIT' });
  await assert.rejects(store.findActiveSourcesForMapping(1, { sourceType: 'unknown' }),
    { code: 'PROVIDER_SOURCE_INVALID_TYPE' });
});

test('catalog → persisted source → manager → DirectHlsResolver validates local manifest',
  async (t) => {
    let requests = 0;
    const referer = 'https://ref.example.test/watch';
    const server = http.createServer((request, response) => {
      requests += 1;
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.referer, referer);
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/master.m3u8`;
    const source = row(1, { source_url: url, headers_json: { referer } });
    const catalog = { version: 1, sources: [{ id: 'fixture', type: 'persisted_sources',
      enabled: true, region: 'global' }] };
    const runtime = createShadowPipeline({ catalogEnabled: true,
      catalogPath: 'fixture.json', catalogReadFile: () => JSON.stringify(catalog),
      providerMappingResolver: { resolve: async () => [ref(movie)] },
      providerSourceStore: { findActiveSourcesForMapping: async () => [source] },
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
      primaryEnabled: true, playbackTransportAvailable: true, healthEnabled: false });
    assert.equal(runtime.sourceRegistry.get('fixture').descriptor.strategy, 'static');
    const resolved = await runtime.pipeline.resolve(movie);
    assert.equal(resolved.streams.length, 1);
    assert.equal(resolved.streams[0].validated, true);
    assert.equal(resolved.streams[0].protocol, 'hls');
    assert.equal(resolved.streams[0].resolverId, 'direct_hls');
    assert.equal(resolved.streams[0].headers.referer, referer);
    assert.equal(resolved.streams[0].metadata.persistedSourceId, source.id);
    assert.equal(requests, 1);
    const primary = await runtime.primaryResolver.resolve(movie);
    assert.equal(primary.status, 'accepted');
  });
