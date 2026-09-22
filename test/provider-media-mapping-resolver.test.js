'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DEFAULT_MAX_MAPPINGS,
  HARD_MAX_MAPPINGS,
  createProviderMediaMappingResolver,
} = require('../src/modules/streams/providerMediaMappingResolver');

const movieInput = () => ({ providerId: 'PLUTO', region: 'LATAM',
  mediaContext: { contentType: 'movie', tmdbId: 550 } });
const row = (overrides = {}) => ({
  id: '1',
  provider_id: 'pluto',
  region: 'latam',
  content_type: 'movie',
  tmdb_id: 550,
  season_number: null,
  episode_number: null,
  external_id: 'external-a',
  provider_title: 'Provider Movie',
  provider_slug: 'provider-movie',
  match_method: 'manual',
  match_confidence: '99.50',
  metadata: { year: 1999, nested: { languages: ['es-419'] } },
  last_verified_at: new Date('2025-01-01T00:00:00Z'),
  ...overrides,
});
const resolverFor = (rows, options = {}) => {
  const calls = [];
  const store = { findActiveMappings: async (lookup) => {
    calls.push(lookup);
    return rows;
  } };
  return { calls, resolver: createProviderMediaMappingResolver({ store, ...options }) };
};

test('movie lookup returns one normalized immutable ProviderMediaRef', async () => {
  const { calls, resolver } = resolverFor([row()]);
  const input = movieInput();
  const before = structuredClone(input);
  const refs = await resolver.resolve(input);
  assert.deepEqual(calls, [{ providerId: 'pluto', region: 'latam', contentType: 'movie',
    tmdbId: 550, seasonNumber: null, episodeNumber: null }]);
  assert.deepEqual(input, before);
  assert.deepEqual(refs[0], {
    mappingId: 1,
    providerId: 'pluto',
    region: 'latam',
    contentType: 'movie',
    tmdbId: 550,
    externalId: 'external-a',
    seasonNumber: null,
    episodeNumber: null,
    providerTitle: 'Provider Movie',
    providerSlug: 'provider-movie',
    matchMethod: 'manual',
    matchConfidence: 99.5,
    metadata: { year: 1999, nested: { languages: ['es-419'] } },
    lastVerifiedAt: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(Object.isFrozen(refs), true);
  assert.equal(Object.isFrozen(refs[0]), true);
  assert.equal(Object.isFrozen(refs[0].metadata), true);
  assert.equal(Object.isFrozen(refs[0].metadata.nested.languages), true);
});

test('multiple mappings preserve store order and maxMappings limits valid results', async () => {
  const rows = [row({ id: 3, external_id: 'third' }),
    row({ id: 2, external_id: 'second' }), row({ id: 1, external_id: 'first' })];
  const all = await resolverFor(rows).resolver.resolve(movieInput());
  assert.deepEqual(all.map(({ externalId }) => externalId), ['third', 'second', 'first']);
  const limited = await resolverFor(rows, { maxMappings: 2 }).resolver.resolve(movieInput());
  assert.deepEqual(limited.map(({ externalId }) => externalId), ['third', 'second']);
  assert.equal(DEFAULT_MAX_MAPPINGS, 8);
  assert.equal(HARD_MAX_MAPPINGS, 32);
});

test('missing and non-array store results fail closed', async () => {
  assert.deepEqual(await resolverFor([]).resolver.resolve(movieInput()), []);
  assert.deepEqual(await resolverFor(null).resolver.resolve(movieInput()), []);
});

test('episode identity is translated exactly to store lookup and runtime ref', async () => {
  const episodeRow = row({ content_type: 'episode', tmdb_id: 42, season_number: 0,
    episode_number: 3, external_id: 'episode-external' });
  const { calls, resolver } = resolverFor([episodeRow]);
  const refs = await resolver.resolve({ providerId: 'pluto', region: 'latam',
    mediaContext: { contentType: 'episode', tmdbId: 42, season: 0, episode: 3 } });
  assert.deepEqual(calls[0], { providerId: 'pluto', region: 'latam',
    contentType: 'episode', tmdbId: 42, seasonNumber: 0, episodeNumber: 3 });
  assert.equal(refs[0].seasonNumber, 0);
  assert.equal(refs[0].episodeNumber, 3);
});

test('invalid movie and episode identities fail closed without consulting store', async () => {
  const { calls, resolver } = resolverFor([row()]);
  for (const mediaContext of [
    { contentType: 'movie', tmdbId: 550, season: 1 },
    { contentType: 'movie', tmdbId: 550, episode: 1 },
    { contentType: 'episode', tmdbId: 42, season: -1, episode: 1 },
    { contentType: 'episode', tmdbId: 42, season: 1, episode: 0 },
    { contentType: 'episode', tmdbId: 42, season: 1 },
    { contentType: 'unknown', tmdbId: 42 },
    { contentType: 'movie', tmdbId: 0 },
  ]) {
    assert.deepEqual(await resolver.resolve({ providerId: 'pluto', region: 'latam',
      mediaContext }), []);
  }
  assert.equal(calls.length, 0);
});

test('malformed rows are discarded while later valid rows retain their order', async () => {
  const malformed = [
    null,
    row({ id: 0 }),
    row({ provider_id: 'other' }),
    row({ region: 'other' }),
    row({ tmdb_id: 999 }),
    row({ season_number: 1 }),
    row({ external_id: '' }),
    row({ match_confidence: 101 }),
    row({ last_verified_at: 'invalid-date' }),
  ];
  const refs = await resolverFor([...malformed, row({ id: 7, external_id: 'valid' })])
    .resolver.resolve(movieInput());
  assert.deepEqual(refs.map(({ externalId }) => externalId), ['valid']);
});

test('metadata is cloned safely and malformed metadata rows are discarded', async () => {
  const metadata = { nested: { value: true } };
  const refs = await resolverFor([
    row({ id: 1, external_id: 'date-metadata', metadata: new Date() }),
    row({ id: 2, external_id: 'array-metadata', metadata: [] }),
    row({ id: 3, external_id: 'safe', metadata }),
    row({ id: 4, external_id: 'missing', metadata: null }),
  ]).resolver.resolve(movieInput());
  metadata.nested.value = false;
  assert.deepEqual(refs.map(({ externalId }) => externalId), ['safe', 'missing']);
  assert.equal(refs[0].metadata.nested.value, true);
  assert.deepEqual(refs[1].metadata, {});
});

test('constructor rejects invalid stores and unsafe maxMappings values', () => {
  for (const store of [null, {}, { findActiveMappings: true }]) {
    assert.throws(() => createProviderMediaMappingResolver({ store }),
      /PROVIDER_MAPPING_RESOLVER_INVALID_STORE/);
  }
  const store = { findActiveMappings: async () => [] };
  for (const maxMappings of [0, -1, 1.5, HARD_MAX_MAPPINGS + 1, Infinity, '8']) {
    assert.throws(() => createProviderMediaMappingResolver({ store, maxMappings }),
      /PROVIDER_MAPPING_RESOLVER_INVALID_MAX_MAPPINGS/);
  }
});

test('store operational errors propagate unchanged', async () => {
  const failure = Object.assign(new Error('safe store failure'), { code: 'MAPPING_DB_FAILED' });
  const resolver = createProviderMediaMappingResolver({
    store: { findActiveMappings: async () => { throw failure; } },
  });
  await assert.rejects(resolver.resolve(movieInput()), (error) => error === failure);
});

test('resolver has no network, browser, provider-specific or global DB coupling', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/providerMediaMappingResolver'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|\bbrowser\b|\bfetch\s*\(|http\.get|https\.get|axios|config\/db|ProviderC|ResolverExecutor|child_process|pluto|peertube/i);
});
