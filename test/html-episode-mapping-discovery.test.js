'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHtmlEpisodeMappingDiscovery } =
  require('../src/ingestion/mappings/htmlEpisodeDiscovery');
const { createProviderMediaMappingResolver } =
  require('../src/modules/streams/providerMediaMappingResolver');
const { createHttpWorkflowSourceProvider, HARD_MAX_STEPS } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { createMappedSourceProviderAdapter } =
  require('../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { CONTENT_TYPES } =
  require('../src/modules/streams/resolverV2/resolverContracts');

const providerId = 'html_episode_fixture';
const series = Object.freeze({ contentType: 'series', tmdbId: 900,
  title: 'Fixture series' });
const episodeMedia = (season, episode) => ({ contentType: 'episode',
  contentId: `episode-${season}-${episode}`, tmdbId: 900,
  title: 'Fixture episode', season, episode });
const encode = (value) => Buffer.from(value, 'utf8').toString('base64');
const leaf = (url, language, variant) => `<li data-source="${encode(url)}" ` +
  `data-language="${language}" data-variant="${variant}" ` +
  'data-source-name="fixture">Option</li>';
const seasonLink = (season, path) =>
  `<a data-season="${season}" data-href="${path}">Season</a>`;
const episodeLink = (episode, path) =>
  `<a data-episode="${episode}" data-href="${path}">Episode</a>`;

const pages = (overrides = {}) => ({
  '/serie/show-1': seasonLink(2, '/temporada/s2') +
    seasonLink(1, '/temporada/s1') + seasonLink(2, '/temporada/s2'),
  '/temporada/s1': episodeLink(3, '/episodio/s1e3') +
    episodeLink(1, '/episodio/s1e1') + episodeLink(1, '/episodio/s1e1'),
  '/temporada/s2': episodeLink(3, '/episodio/s2e3') +
    episodeLink(1, '/episodio/s2e1'),
  '/episodio/s1e1': leaf('https://media.example.test/s1e1.m3u8', 'es', '1'),
  '/episodio/s1e3': '',
  '/episodio/s2e1': '',
  '/episodio/s2e3': leaf('https://media.example.test/s2e3.m3u8', 'es-419', '1') +
    leaf('https://media.example.test/s2e3.m3u8', 'en', '2'),
  ...overrides,
});

const fixture = async (t, entries = pages()) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (!Object.hasOwn(entries, request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(entries[request.url]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
};

const discovery = (baseUrl, options = {}) => createHtmlEpisodeMappingDiscovery({
  providerId, region: 'global', baseUrl,
  seriesPathTemplate: '/serie/{externalId}',
  http: createSafeHttpClient({ allowPrivateNetworks: true }),
  ...options,
});

const memoryStore = () => {
  const records = new Map();
  let nextId = 1;
  const key = (row) => `${row.providerId}:${row.region}:${row.contentType}:${row.externalId}`;
  return {
    records,
    upsertMapping: async (mapping) => {
      const identity = key(mapping);
      if (records.has(identity)) return { change: 'unchanged' };
      records.set(identity, { id: nextId++, provider_id: mapping.providerId,
        region: mapping.region, content_type: mapping.contentType,
        tmdb_id: mapping.tmdbId, season_number: mapping.seasonNumber,
        episode_number: mapping.episodeNumber, external_id: mapping.externalId,
        provider_title: null, provider_slug: null,
        match_method: mapping.matchMethod, match_confidence: null,
        metadata: mapping.metadata, last_verified_at: mapping.lastVerifiedAt });
      return { change: 'inserted' };
    },
    findActiveMappings: async (input) => [...records.values()].filter((row) =>
      row.provider_id === input.providerId && row.region === input.region &&
      row.content_type === input.contentType && row.tmdb_id === input.tmdbId &&
      row.season_number === input.seasonNumber &&
      row.episode_number === input.episodeNumber),
  };
};

const leafWorkflow = [
  { type: 'request', method: 'GET', path: '{externalId}', saveAs: 'detail' },
  { type: 'extractMany', from: 'detail', parser: 'html', selector: 'li[data-source]',
    fields: { source: 'data-source', language: 'data-language',
      variant: 'data-variant', sourceName: 'data-source-name' }, saveAs: 'options' },
  { type: 'decodeBase64Many', from: 'options', field: 'source',
    targetField: 'url', saveAs: 'decoded' },
  { type: 'filterMany', from: 'decoded', field: 'url',
    urlProtocol: 'https', saveAs: 'secure' },
  { type: 'emitEach', from: 'secure', url: '{item.url}',
    languageHint: '{item.language}', metadataFields: {
      variant: 'variant', source: 'sourceName' } },
];

test('discovery yields exact episode mappings from two bounded, unordered seasons',
  async (t) => {
    const local = await fixture(t);
    const mappings = await discovery(local.baseUrl).discover({
      series, externalId: 'show-1' });
    assert.deepEqual(local.requests,
      ['/serie/show-1', '/temporada/s1', '/temporada/s2']);
    assert.deepEqual(mappings.map((mapping) => [mapping.tmdbId,
      mapping.seasonNumber, mapping.episodeNumber, mapping.externalId]), [
      [900, 1, 1, '/episodio/s1e1'],
      [900, 1, 3, '/episodio/s1e3'],
      [900, 2, 1, '/episodio/s2e1'],
      [900, 2, 3, '/episodio/s2e3'],
    ]);
    assert.ok(mappings.every((mapping) => mapping.contentType === 'episode' &&
      mapping.matchMethod === 'structured_episode_hierarchy'));
  });

test('store upsert rerun is idempotent and exact resolver never crosses season/episode',
  async (t) => {
    const local = await fixture(t);
    const discoverer = discovery(local.baseUrl);
    const store = memoryStore();
    for (let run = 0; run < 2; run += 1) {
      for (const mapping of await discoverer.discover({ series, externalId: 'show-1' })) {
        const result = await store.upsertMapping(mapping);
        assert.equal(result.change, run === 0 ? 'inserted' : 'unchanged');
      }
    }
    assert.equal(store.records.size, 4);
    const resolver = createProviderMediaMappingResolver({ store });
    const lookup = (season, episode) => resolver.resolve({
      providerId, region: 'global', mediaContext: episodeMedia(season, episode),
    });
    assert.deepEqual((await lookup(2, 3)).map((ref) => ref.externalId),
      ['/episodio/s2e3']);
    assert.deepEqual((await lookup(1, 3)).map((ref) => ref.externalId),
      ['/episodio/s1e3']);
    assert.deepEqual(await lookup(2, 2), []);
    assert.deepEqual(await lookup(3, 3), []);
    assert.equal(local.requests.filter((path) => path.startsWith('/episodio/')).length, 0);
  });

test('playback uses generated exact mapping and only requests the episode leaf',
  async (t) => {
    const local = await fixture(t);
    const store = memoryStore();
    for (const mapping of await discovery(local.baseUrl).discover({
      series, externalId: 'show-1' })) await store.upsertMapping(mapping);
    local.requests.length = 0;
    const httpClient = createSafeHttpClient({ allowPrivateNetworks: true });
    const provider = createHttpWorkflowSourceProvider({ id: providerId,
      enabled: true, baseUrl: local.baseUrl, http: httpClient,
      maxSteps: HARD_MAX_STEPS, workflow: leafWorkflow });
    const mapped = createMappedSourceProviderAdapter({ provider, providerId,
      region: 'global', mappingResolver: createProviderMediaMappingResolver({ store }) });
    const manager = createSourceProviderManager({
      registry: createSourceProviderRegistry([mapped]), http: httpClient });
    const result = await manager.getSources(episodeMedia(2, 3));
    assert.deepEqual(local.requests, ['/episodio/s2e3']);
    assert.deepEqual(result.candidates.map(({ url, languageHint, metadata }) =>
      [url, languageHint, metadata.variant, metadata.source]), [
      ['https://media.example.test/s2e3.m3u8', 'es-419', '1', 'fixture'],
      ['https://media.example.test/s2e3.m3u8', 'en', '2', 'fixture'],
    ]);
    assert.equal(leafWorkflow.length, 5);
    assert.equal(HARD_MAX_STEPS, 8);
    assert.deepEqual(CONTENT_TYPES, ['movie', 'episode']);
  });

test('empty seasons, conflicting duplicates and unsafe links fail closed', async (t) => {
  const local = await fixture(t, pages({
    '/serie/show-1': seasonLink(1, '/temporada/s1') +
      seasonLink(2, '/temporada/s2') +
      seasonLink(2, '/temporada/other') +
      seasonLink(3, 'http://outside.example.test/season'),
    '/temporada/s1': '',
  }));
  assert.deepEqual(await discovery(local.baseUrl).discover({
    series, externalId: 'show-1' }), []);
  assert.deepEqual(local.requests, ['/serie/show-1', '/temporada/s1']);
});

test('discovery rejects over-limit hierarchies before fetching season pages',
  async (t) => {
    const local = await fixture(t, pages({ '/serie/show-1': [1, 2, 3]
      .map((n) => seasonLink(n, `/temporada/s${n}`)).join('') }));
    await assert.rejects(discovery(local.baseUrl, { maxSeasons: 2 }).discover({
      series, externalId: 'show-1' }), /HTML_EPISODE_DISCOVERY_LIMIT_EXCEEDED/);
    assert.deepEqual(local.requests, ['/serie/show-1']);
  });
