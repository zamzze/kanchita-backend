'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, HARD_MAX_STEPS } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { createMappedSourceProviderAdapter } =
  require('../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { normalizeMediaContext, normalizeEmbedCandidate } =
  require('../src/modules/streams/resolverV2/resolverContracts');
const { normalizeIdentity } =
  require('../src/modules/streams/providerMediaMappingResolver');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');

const ID = 'html_embed_fixture';
const movie = Object.freeze({ contentType: 'movie', contentId: 'movie-fixture',
  tmdbId: 550, title: 'Fixture movie' });
const episode = Object.freeze({ contentType: 'episode', contentId: 'episode-fixture',
  tmdbId: 900, season: 2, episode: 3, title: 'Fixture episode' });
const mapping = (media, externalId) => Object.freeze({ mappingId: 1,
  providerId: ID, region: 'global', contentType: media.contentType,
  tmdbId: media.tmdbId, seasonNumber: media.season ?? null,
  episodeNumber: media.episode ?? null, externalId });
const encoded = (url) => Buffer.from(url, 'utf8').toString('base64');
const option = (url, language, variant, source = 'fixture') =>
  `<li data-source="${encoded(url)}" data-language="${language}" ` +
  `data-variant="${variant}" data-source-name="${source}">Option</li>`;

const leafWorkflow = (path, maxItems = 8) => [
  { type: 'request', method: 'GET', path, saveAs: 'detail' },
  { type: 'extractMany', from: 'detail', parser: 'html',
    selector: 'li[data-source]', fields: { source: 'data-source',
      language: 'data-language', variant: 'data-variant',
      sourceName: 'data-source-name' }, saveAs: 'options', maxItems },
  { type: 'decodeBase64Many', from: 'options', field: 'source',
    targetField: 'url', saveAs: 'decoded' },
  { type: 'filterMany', from: 'decoded', field: 'url',
    urlProtocol: 'https', saveAs: 'secure' },
  { type: 'emitEach', from: 'secure', url: '{item.url}',
    languageHint: '{item.language}', metadata: { family: 'html_embed_leaf' },
    metadataFields: { variant: 'variant', source: 'sourceName' } },
];

const seriesNavigationWorkflow = [
  { type: 'request', method: 'GET', path: '/serie/{externalId}', saveAs: 'seriesPage' },
  { type: 'extractMany', from: 'seriesPage', parser: 'html',
    selector: 'a[data-season]', fields: { path: 'data-href',
      number: 'data-season' }, saveAs: 'seasons' },
  { type: 'filterMany', from: 'seasons', field: 'number', equals: '{season}',
    saveAs: 'selectedSeason', maxItems: 1 },
  { type: 'bindOne', from: 'selectedSeason', fields: { seasonPath: 'path' } },
  { type: 'request', method: 'GET', path: '{seasonPath}', saveAs: 'seasonPage' },
  { type: 'extractMany', from: 'seasonPage', parser: 'html',
    selector: 'a[data-episode]', fields: { path: 'data-href',
      number: 'data-episode' }, saveAs: 'episodes' },
  { type: 'filterMany', from: 'episodes', field: 'number', equals: '{episode}',
    saveAs: 'selectedEpisode', maxItems: 1 },
  { type: 'bindOne', from: 'selectedEpisode', fields: { episodePath: 'path' } },
  ...leafWorkflow('{episodePath}'),
];

const fixture = async (t, pages) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (!Object.hasOwn(pages, request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pages[request.url]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
};

const getSources = async (baseUrl, workflow, media, ref, maxCandidates = 8) => {
  const httpClient = createSafeHttpClient({ allowPrivateNetworks: true });
  const provider = createHttpWorkflowSourceProvider({ id: ID, enabled: true,
    baseUrl, workflow, maxSteps: HARD_MAX_STEPS, maxCandidates,
    http: httpClient });
  const mapped = createMappedSourceProviderAdapter({ provider,
    providerId: ID, region: 'global', mappingResolver: {
      resolve: async () => ref ? [ref] : [],
    } });
  const manager = createSourceProviderManager({
    registry: createSourceProviderRegistry([mapped]), http: httpClient,
    maxCandidates,
  });
  return manager.getSources(media);
};

test('HTML_EMBED_LEAF movie preserves ordered structured options and exact dedup',
  async (t) => {
    const a = 'https://media.example.test/a.m3u8';
    const b = 'https://media.example.test/b.m3u8';
    const pages = { '/pelicula/movie-1': [
      option(a, 'es-419', '1', 'source_a'),
      option(a, 'es-419', '1', 'source_a'),
      option(a, 'es-419', '2', 'source_b'),
      option(b, 'en', '1', 'source_c'),
      '<li data-source="bad!" data-language="es" data-variant="3" ' +
        'data-source-name="bad">Invalid</li>',
      option('http://media.example.test/plain.m3u8', 'es', '4'),
      `<li data-source="${encoded(b)}" data-variant="5" ` +
        'data-source-name="missing">Missing language</li>',
    ].join('') };
    const local = await fixture(t, pages);
    const result = await getSources(local.baseUrl,
      leafWorkflow('/pelicula/{externalId}'), movie, mapping(movie, 'movie-1'));
    assert.deepEqual(local.requests, ['/pelicula/movie-1']);
    assert.deepEqual(result.candidates.map(({ url, languageHint, metadata }) => ({
      url, languageHint, variant: metadata.variant, source: metadata.source,
    })), [
      { url: a, languageHint: 'es-419', variant: '1', source: 'source_a' },
      { url: a, languageHint: 'es-419', variant: '2', source: 'source_b' },
      { url: b, languageHint: 'en', variant: '1', source: 'source_c' },
    ]);
    assert.ok(result.candidates.every((candidate) =>
      candidate.providerId === ID && normalizeEmbedCandidate(candidate)));
    assert.equal(result.trace.candidateCount, 3);
  });

test('HTML_EMBED_LEAF episode emits 0..N options without inferred metadata',
  async (t) => {
    const a = 'https://media.example.test/episode-a.m3u8';
    const b = 'https://media.example.test/episode-b.m3u8';
    const local = await fixture(t, {
      '/episodio/episode-3': option(a, 'es-419', '1') +
        option(b, 'es-419', '2') + option(a, 'en', '1'),
      '/episodio/empty': '',
    });
    const workflow = leafWorkflow('/episodio/{externalId}');
    const result = await getSources(local.baseUrl, workflow, episode,
      mapping(episode, 'episode-3'));
    assert.deepEqual(result.candidates.map(({ url, languageHint, metadata }) =>
      [url, languageHint, metadata.variant]), [
      [a, 'es-419', '1'], [b, 'es-419', '2'], [a, 'en', '1'],
    ]);
    const empty = await getSources(local.baseUrl, workflow, episode,
      mapping(episode, 'empty'));
    assert.deepEqual(empty.candidates, []);
    const absent = await getSources(local.baseUrl, workflow, episode, null);
    assert.deepEqual(absent.candidates, []);
    assert.deepEqual(local.requests,
      ['/episodio/episode-3', '/episodio/empty']);
  });

test('leaf collection and candidate limits remain bounded without extra requests',
  async (t) => {
    const local = await fixture(t, { '/pelicula/bounded': [1, 2, 3].map((n) =>
      option(`https://media.example.test/${n}.m3u8`, 'es', String(n))).join('') });
    const result = await getSources(local.baseUrl,
      leafWorkflow('/pelicula/{externalId}', 2), movie,
      mapping(movie, 'bounded'), 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].metadata.variant, '1');
    assert.deepEqual(local.requests, ['/pelicula/bounded']);
  });

test('HTML_SERIES_NAVIGATION exposes current 8-step and series MediaContext gaps',
  async (t) => {
    const local = await fixture(t, {
      '/serie/show-1': '<a data-season="2" data-href="/temporada/s2">2</a>',
      '/temporada/s2': '<a data-episode="3" data-href="/episodio/e3">3</a>',
      '/episodio/e3': option('https://media.example.test/e3.m3u8', 'es', '1'),
    });
    assert.equal(seriesNavigationWorkflow.length, 13);
    assert.equal(HARD_MAX_STEPS, 8);
    assert.ok(normalizeWorkflow(seriesNavigationWorkflow.slice(0, 8), 8));
    assert.equal(normalizeWorkflow(seriesNavigationWorkflow, 8), null);
    const catalog = normalizeCatalog({ version: 1, sources: [{ id: ID,
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: local.baseUrl, maxSteps: 8, workflow: seriesNavigationWorkflow }] });
    assert.equal(catalog.sources.length, 0);
    assert.equal(catalog.summary.skippedSources, 1);
    const series = { contentType: 'series', contentId: 'series-fixture',
      tmdbId: 900, title: 'Fixture series' };
    assert.ok(normalizeIdentity({ providerId: ID, region: 'global',
      mediaContext: series }));
    assert.equal(normalizeMediaContext(series), null);
    assert.deepEqual(local.requests, []);
  });
