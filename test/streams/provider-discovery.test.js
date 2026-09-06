'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { selectProviderMatch } = require('../../src/modules/streams/contentMatching');
const { normalizeProviderStream } = require('../../src/modules/streams/providerCandidate');
const { scoreProviderProfile } = require('../../src/modules/streams/providerDiscoveryScore');
const { createProviderManager } = require('../../src/modules/streams/providerManager');
const { createProviderRegistry } = require('../../src/modules/streams/providerRegistry');
const { normalizeLanguage, normalizeQuality } = require('../../src/modules/streams/streamAttributes');

test('language and quality aliases normalize to the shared model', () => {
  for (const alias of ['latino', 'latin', 'latam', 'spanish-latin', 'spanish latam',
    'es-lat', 'es-latam', 'spa-lat', 'es-mx', 'es-us']) {
    assert.equal(normalizeLanguage(alias), 'es-419');
  }
  assert.equal(normalizeLanguage('pt-BR'), 'pt');
  for (const alias of ['4k', '2160', '2160p', 'UHD']) {
    assert.equal(normalizeQuality(alias), '2160p');
  }
  for (const alias of ['FULLHD', 'Full HD', 'FHD', '1080', '1080p']) {
    assert.equal(normalizeQuality(alias), '1080p');
  }
});

test('normalized stream model does not leak provider-specific fields', () => {
  assert.deepEqual(normalizeProviderStream({
    url: 'https://media.example/master.m3u8', quality: 'FHD', language: 'es-MX',
    secretProviderField: 'discard-me',
  }, { provider: 'fixture', contentType: 'movie', contentId: 'movie-1' }), {
    provider: 'fixture', content_type: 'movie', content_id: 'movie-1',
    stream_url: 'https://media.example/master.m3u8', stream_type: 'hls',
    quality: '1080p', audio_language: 'es-419', subtitle_language: null,
    cleanliness: 'unknown', strategy: 'direct', expires_at: null, priority: 1,
  });
});

test('matching prefers identifiers and rejects contradictory metadata', () => {
  const candidates = [
    { tmdbId: 20, title: 'Same title', year: 2020 },
    { tmdbId: 10, title: 'Wrong title', year: 1990 },
  ];
  assert.equal(selectProviderMatch({ tmdbId: 10, title: 'Same title', year: 2020 }, candidates),
    candidates[1]);
  assert.equal(selectProviderMatch({ title: 'Same title', year: 2021 }, [candidates[0]]), null);
  assert.equal(selectProviderMatch({ contentType: 'episode', title: 'Show', year: 2020,
    season: 1, episode: 2 }, [{ title: 'Show', year: 2020, season: 1, episode: 3 }]), null);
});

test('discovery score never overrides exclusion rules', () => {
  const attractiveButDrm = scoreProviderProfile({
    directHls: true, documentedApi: true, noBrowser: true, quality1080p: true,
    es419Audio: true, clean: true, drm: true,
  });
  assert.equal(attractiveButDrm.eligible, false);
  assert.deepEqual(attractiveButDrm.excludedBy, ['drm']);
  assert.equal(scoreProviderProfile({ directHls: true, documentedApi: true,
    noBrowser: true, clean: true }).eligible, true);
  assert.equal(scoreProviderProfile({ documentedApi: true, unknownRights: true }).eligible,
    false);
});

test('disabled providers are not compatible or invoked', async () => {
  let calls = 0;
  const registry = createProviderRegistry([{ id: 'disabled_fixture', strategy: 'direct',
    enabled: false, resolve: async () => { calls += 1; } }]);
  assert.deepEqual(registry.compatible('movie'), []);
  assert.equal(calls, 0);
});

test('manager returns and globally ranks multiple normalized candidates', async () => {
  const manager = createProviderManager({
    providers: [
      { id: 'provider_a', strategy: 'direct', resolve: async () => [
        { url: 'https://media.example/a-720.m3u8', quality: '720p', language: 'en' },
        { url: 'https://media.example/a-1080.m3u8', quality: '1080p', language: 'es' },
      ] },
      { id: 'provider_b', strategy: 'direct', resolve: async () => ({
        url: 'https://media.example/b-2160.m3u8', quality: '4k', language: 'latino',
      }) },
    ],
    validator: async () => ({ valid: true, manifest: '#EXTM3U\n#EXTINF:10,\nsegment.ts' }),
  });
  const candidates = await manager.resolveCandidates({ contentType: 'movie', contentId: '1' });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].provider, 'provider_b');
  assert.equal(candidates[0].quality, '2160p');
  assert.equal(candidates[0].audioLanguage, 'es-419');
  assert.equal((await manager.resolve({ contentType: 'movie', contentId: '1' })).provider,
    'provider_b');
});
