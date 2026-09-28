'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { createMappedSourceProviderAdapter } =
  require('../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { normalizeEmbedCandidate } =
  require('../src/modules/streams/resolverV2/resolverContracts');

const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/item/{externalId}', saveAs: 'response' });
const extract = Object.freeze({ type: 'extractMany', from: 'response', parser: 'html',
  selector: 'li[data-source]', fields: { source: 'data-source',
    language: 'data-language', variant: 'data-variant',
    sourceName: 'data-source-name', label: '$text' },
  saveAs: 'options' });
const decode = Object.freeze({ type: 'decodeBase64Many', from: 'options',
  field: 'source', targetField: 'url', saveAs: 'decoded' });
const filter = Object.freeze({ type: 'filterMany', from: 'decoded', field: 'url',
  urlProtocol: 'https', saveAs: 'secure' });
const emit = Object.freeze({ type: 'emitEach', from: 'secure',
  url: '{item.url}', languageHint: '{item.language}',
  metadata: { provider: 'html_options' },
  metadataFields: { variant: 'variant', label: 'label', source: 'sourceName' } });
const workflow = (extractStep = extract, emitStep = emit) =>
  [request, extractStep, decode, filter, emitStep];
const media = Object.freeze({ contentType: 'movie', contentId: 'fixture', tmdbId: 550,
  title: 'Fixture' });
const episodeMedia = Object.freeze({ contentType: 'episode', contentId: 'fixture-episode',
  tmdbId: 900, season: 2, episode: 3, title: 'Fixture S2E3' });
const ref = Object.freeze({ mappingId: 1, providerId: 'html_options', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'item-1',
  seasonNumber: null, episodeNumber: null });
const episodeRef = Object.freeze({ ...ref, mappingId: 2, contentType: 'episode',
  tmdbId: 900, seasonNumber: 2, episodeNumber: 3 });
const base64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const option = (url, language, variant, text, sourceName = 'fixture_detail') =>
  `<li data-source="${base64(url)}" data-language="${language}" ` +
  `data-variant="${variant}" data-source-name="${sourceName}">${text}</li>`;

const getLocalSources = async (t, html, steps = workflow(), maxCandidates = 8,
  { managed = false, mediaContext = media, mapping = ref } = {}) => {
  const seen = [];
  const server = http.createServer((incoming, response) => {
    seen.push(incoming.url);
    if (incoming.url !== '/item/item-1') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const provider = createHttpWorkflowSourceProvider({ id: 'html_options',
    enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`,
    workflow: steps, maxSteps: 8, maxCandidates,
    http: client });
  if (!managed) {
    const candidates = await provider.getSources(mediaContext, { providerMediaRef: mapping });
    return { seen, candidates };
  }
  const mappingCalls = [];
  const mappedProvider = createMappedSourceProviderAdapter({ provider,
    providerId: 'html_options', region: 'global', mappingResolver: {
      resolve: async (input) => {
        mappingCalls.push(input);
        return mapping ? [mapping] : [];
      },
    } });
  const registry = createSourceProviderRegistry([mappedProvider]);
  const result = await createSourceProviderManager({ registry, http: client,
    maxCandidates }).getSources(mediaContext);
  return { seen, mappingCalls, ...result };
};

test('same-element attributes and text stay paired through decode, filter and emit',
  async (t) => {
    const urlA = 'https://media.example.test/latino.m3u8';
    const urlB = 'https://media.example.test/english.m3u8';
    const html = option(urlA, 'latino', 1, 'Opción 1 · Latino') +
      option(urlB, 'en', 2, 'Opción 2 · English') +
      option(urlA, 'latino', 3, 'Opción 3 · Latino');
    const { seen, candidates } = await getLocalSources(t, html);
    assert.deepEqual(seen, ['/item/item-1']);
    assert.deepEqual(candidates.map(({ url, languageHint, metadata }) => ({
      url, languageHint, variant: metadata.variant, label: metadata.label,
    })), [
      { url: urlA, languageHint: 'latino', variant: '1', label: 'Opción 1 · Latino' },
      { url: urlB, languageHint: 'en', variant: '2', label: 'Opción 2 · English' },
      { url: urlA, languageHint: 'latino', variant: '3', label: 'Opción 3 · Latino' },
    ]);
    assert.ok(candidates.every((candidate) => Object.isFrozen(candidate)));
  });

test('missing fields, invalid Base64 and non-HTTPS URLs discard only affected options',
  async (t) => {
    const valid = 'https://media.example.test/valid.m3u8';
    const html = '<li data-source="bad!" data-language="latino" ' +
      'data-variant="1">Invalid</li>' +
      `<li data-source="${base64(valid)}" data-variant="2">Missing language</li>` +
      option('http://media.example.test/plain.m3u8', 'en', 3, 'HTTP') +
      option(valid, 'latino', 4, 'Opción 4 · Latino');
    const { candidates } = await getLocalSources(t, html);
    assert.deepEqual(candidates.map(({ url, languageHint, metadata }) => ({
      url, languageHint, variant: metadata.variant,
    })), [{ url: valid, languageHint: 'latino', variant: '4' }]);
  });

test('free text is preserved, not guessed into language or numeric variant', async (t) => {
  const html = `<li data-source="${base64('https://media.example.test/a.m3u8')}">` +
    'Opción 2 · Latino</li>';
  assert.deepEqual((await getLocalSources(t, html)).candidates, []);
});

test('empty, oversized text and collection/candidate limits stay bounded', async (t) => {
  const url = 'https://media.example.test/a.m3u8';
  const html = option(url, 'latino', 1, 'x'.repeat(4097)) +
    option(url, 'latino', 2, 'Second') +
    option(url, 'latino', 3, 'Third');
  const { candidates } = await getLocalSources(t, html,
    workflow({ ...extract, maxItems: 2 }));
  assert.deepEqual(candidates.map(({ metadata }) => metadata.variant), ['2']);
  const limited = await getLocalSources(t,
    option(url, 'latino', 1, 'First') + option(url, 'en', 2, 'Second'),
    workflow(), 1);
  assert.equal(limited.candidates.length, 1);
  assert.deepEqual((await getLocalSources(t, '')).candidates, []);
});

test('normalization is immutable/idempotent and fails closed on unsafe fields', () => {
  const normalized = normalizeWorkflow(workflow(), 8);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.equal(Object.isFrozen(normalized[1].fields), true);
  assert.equal(Object.isFrozen(normalized[4].metadataFields), true);
  for (const fields of [
    { source: 'data-source', label: '$text', bad: '$unknown' },
    JSON.parse('{"__proto__":"$text"}'),
    { source: 'data-source', label: 'constructor' },
  ]) assert.equal(normalizeWorkflow(workflow({ ...extract, fields }), 8), null);
  for (const metadataFields of [
    { variant: 'missing' }, JSON.parse('{"__proto__":"variant"}'),
    { variant: '__proto__' }, { variant: 2 },
  ]) assert.equal(normalizeWorkflow(workflow(extract,
    { ...emit, metadataFields }), 8), null);
  assert.equal(normalizeWorkflow(workflow(extract,
    { ...emit, metadata: { variant: 'fixed' } }), 8), null);
  assert.equal(normalizeWorkflow([request, { ...extract, parser: 'json',
    path: '$' }, decode, filter, emit], 8), null);
});

test('mapped movie detail reaches SourceProviderManager with ordered option metadata',
  async (t) => {
    const first = 'https://media.example.test/movie-a.m3u8';
    const second = 'https://media.example.test/movie-b.m3u8';
    const html = option(first, 'latino', 1, 'Opción 1 · Latino', 'source_a') +
      option(second, 'en', 2, 'Opción 2 · English', 'source_b') +
      option(first, 'latino', 3, 'Opción 3 · Latino', 'source_c');
    const { seen, mappingCalls, candidates, trace } = await getLocalSources(t, html,
      workflow(), 8, { managed: true });
    assert.deepEqual(seen, ['/item/item-1']);
    assert.equal(mappingCalls.length, 1);
    assert.deepEqual(mappingCalls[0].mediaContext, { ...media, season: null, episode: null });
    assert.deepEqual(candidates.map(({ url, languageHint, metadata }) => ({
      url, languageHint, variant: metadata.variant, label: metadata.label,
      source: metadata.source, provider: metadata.provider,
    })), [
      { url: first, languageHint: 'latino', variant: '1', label: 'Opción 1 · Latino',
        source: 'source_a', provider: 'html_options' },
      { url: second, languageHint: 'en', variant: '2', label: 'Opción 2 · English',
        source: 'source_b', provider: 'html_options' },
      { url: first, languageHint: 'latino', variant: '3', label: 'Opción 3 · Latino',
        source: 'source_c', provider: 'html_options' },
    ]);
    assert.ok(candidates.every((candidate) => candidate.providerId === 'html_options' &&
      candidate.metadata.sourcePriority === 100 && normalizeEmbedCandidate(candidate)));
    assert.equal(trace.candidateCount, 3);
  });

test('mapped episode detail emits only valid HTTPS options through SourceProviderManager',
  async (t) => {
    const first = 'https://media.example.test/episode-a.m3u8';
    const second = 'https://media.example.test/episode-b.m3u8';
    const html = option(first, 'es-419', 1, 'Latino') +
      '<li data-source="bad!" data-language="es" data-variant="2">Bad</li>' +
      option('http://media.example.test/plain.m3u8', 'en', 3, 'HTTP') +
      `<li data-source="${base64(first)}" data-variant="4">Missing language</li>` +
      `<li data-source="${base64(first)}" data-language="es" ` +
      'data-variant="4">Missing source</li>' +
      option(second, 'en', 5, 'Original');
    const { seen, mappingCalls, candidates } = await getLocalSources(t, html,
      workflow(), 8, { managed: true, mediaContext: episodeMedia, mapping: episodeRef });
    assert.deepEqual(seen, ['/item/item-1']);
    assert.equal(mappingCalls.length, 1);
    assert.deepEqual(mappingCalls[0].mediaContext, episodeMedia);
    assert.deepEqual(candidates.map(({ url, languageHint, metadata }) => ({
      url, languageHint, variant: metadata.variant, source: metadata.source,
    })), [
      { url: first, languageHint: 'es-419', variant: '1', source: 'fixture_detail' },
      { url: second, languageHint: 'en', variant: '5', source: 'fixture_detail' },
    ]);
    assert.ok(candidates.every((candidate) => normalizeEmbedCandidate(candidate)));
  });

test('zero options, absent mapping, exact duplicates and limits avoid undeclared requests',
  async (t) => {
    const url = 'https://media.example.test/limited.m3u8';
    const noOptions = await getLocalSources(t, '', workflow(), 8, { managed: true });
    assert.deepEqual(noOptions.candidates, []);
    assert.deepEqual(noOptions.seen, ['/item/item-1']);
    const noMapping = await getLocalSources(t, option(url, 'es', 1, 'A'),
      workflow(), 8, { managed: true, mapping: null });
    assert.deepEqual(noMapping.candidates, []);
    assert.deepEqual(noMapping.seen, []);
    const duplicates = await getLocalSources(t, option(url, 'es', 1, 'A') +
      option(url, 'es', 1, 'A'), workflow(), 8, { managed: true });
    assert.deepEqual(duplicates.seen, ['/item/item-1']);
    assert.equal(duplicates.candidates.length, 1);
    const limited = await getLocalSources(t, option(url, 'es', 1, 'A') +
      option('https://media.example.test/other.m3u8', 'en', 2, 'B'),
    workflow(), 1, { managed: true });
    assert.deepEqual(limited.seen, ['/item/item-1']);
    assert.deepEqual(limited.candidates.map(({ metadata }) => metadata.variant), ['1']);
  });
