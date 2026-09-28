'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');

const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/item/{externalId}', saveAs: 'response' });
const extract = Object.freeze({ type: 'extractMany', from: 'response', parser: 'html',
  selector: 'li[data-source]', fields: { source: 'data-source',
    language: 'data-language', variant: 'data-variant', label: '$text' },
  saveAs: 'options' });
const decode = Object.freeze({ type: 'decodeBase64Many', from: 'options',
  field: 'source', targetField: 'url', saveAs: 'decoded' });
const filter = Object.freeze({ type: 'filterMany', from: 'decoded', field: 'url',
  urlProtocol: 'https', saveAs: 'secure' });
const emit = Object.freeze({ type: 'emitEach', from: 'secure',
  url: '{item.url}', languageHint: '{item.language}',
  metadataFields: { variant: 'variant', label: 'label' } });
const workflow = (extractStep = extract, emitStep = emit) =>
  [request, extractStep, decode, filter, emitStep];
const media = Object.freeze({ contentType: 'movie', contentId: 'fixture', tmdbId: 550 });
const ref = Object.freeze({ mappingId: 1, providerId: 'html_options', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'item-1',
  seasonNumber: null, episodeNumber: null });
const base64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const option = (url, language, variant, text) =>
  `<li data-source="${base64(url)}" data-language="${language}" ` +
  `data-variant="${variant}">${text}</li>`;

const getLocalSources = async (t, html, steps = workflow(), maxCandidates = 8) => {
  const seen = [];
  const server = http.createServer((incoming, response) => {
    seen.push(incoming.url);
    if (incoming.url !== '/item/item-1') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const provider = createHttpWorkflowSourceProvider({ id: 'html_options',
    enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`,
    workflow: steps, maxSteps: 8, maxCandidates,
    http: createSafeHttpClient({ allowPrivateNetworks: true }) });
  const candidates = await provider.getSources(media, { providerMediaRef: ref });
  return { seen, candidates };
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
