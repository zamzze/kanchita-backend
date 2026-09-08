'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  SOURCE_STRATEGIES,
  createSourceProviderRegistry,
} = require('../src/modules/streams/resolverV2/sourceProviderRegistry');

const movie = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10, title: 'Fixture',
};
const episode = {
  contentType: 'episode', contentId: 'episode-fixture', tmdbId: 20,
  title: 'Fixture Series', season: 1, episode: 2,
};
const provider = (id, overrides = {}) => ({
  descriptor: {
    id, active: true, priority: 10, supportsMovies: true, supportsEpisodes: true,
    languages: ['es-419', 'en'], strategy: 'static', timeoutMs: 100,
    maxCandidates: 5,
    ...overrides,
  },
  getSources: async () => [],
});

test('registry registers, retrieves and lists immutable providers', () => {
  const registry = createSourceProviderRegistry();
  const registered = registry.register(provider('fixture'));
  assert.equal(registry.get('fixture'), registered);
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registered.descriptor.languages, ['es-419', 'en']);
  assert.deepEqual(SOURCE_STRATEGIES, ['http', 'static', 'legacy']);
  const listed = registry.list();
  listed.length = 0;
  assert.equal(registry.list().length, 1);
  assert.ok(Object.isFrozen(registered));
  assert.ok(Object.isFrozen(registered.descriptor));
  assert.ok(Object.isFrozen(registered.descriptor.languages));
});

test('registry rejects duplicates, missing methods and malformed descriptors', () => {
  const registry = createSourceProviderRegistry([provider('fixture')]);
  assert.throws(() => registry.register(provider('fixture')),
    (error) => error.code === 'SOURCE_PROVIDER_DUPLICATE_ID');
  assert.throws(() => createSourceProviderRegistry([{ descriptor: provider('x').descriptor }]),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_PROVIDER');
  for (const bad of [
    { id: '' }, { active: 1 }, { priority: 1.5 }, { supportsMovies: null },
    { supportsEpisodes: null }, { strategy: 'browser' }, { languages: 'es' },
    { timeoutMs: 0 }, { timeoutMs: 120_001 }, { maxCandidates: 0 },
    { maxCandidates: 101 },
  ]) {
    assert.throws(() => createSourceProviderRegistry([provider('bad', bad)]),
      (error) => error.code === 'SOURCE_PROVIDER_INVALID_PROVIDER');
  }
});

test('media filtering honors active, movie and episode support', () => {
  const registry = createSourceProviderRegistry([
    provider('movie', { priority: 20, supportsEpisodes: false }),
    provider('episode', { priority: 10, supportsMovies: false }),
    provider('inactive', { active: false, priority: 100 }),
  ]);
  assert.deepEqual(registry.listForMedia(movie).map((item) => item.descriptor.id), ['movie']);
  assert.deepEqual(registry.listForMedia(episode).map((item) => item.descriptor.id), ['episode']);
  assert.throws(() => registry.listForMedia({}),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
});

test('priority descending and id ascending make ordering deterministic', () => {
  const registry = createSourceProviderRegistry([
    provider('low', { priority: 1 }),
    provider('zeta', { priority: 50 }),
    provider('alpha', { priority: 50 }),
  ]);
  assert.deepEqual(registry.list().map((item) => item.descriptor.id),
    ['alpha', 'zeta', 'low']);
  assert.deepEqual(registry.listForMedia(movie).map((item) => item.descriptor.id),
    ['alpha', 'zeta', 'low']);
});
