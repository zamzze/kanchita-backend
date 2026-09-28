'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, ERROR_CODES } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');

const media = Object.freeze({ contentType: 'movie', contentId: 'fixture', tmdbId: 550 });
const ref = Object.freeze({ mappingId: 1, providerId: 'base64_fixture', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'item-1',
  seasonNumber: null, episodeNumber: null });
const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/item/{externalId}', saveAs: 'response' });
const jsonMany = Object.freeze({ type: 'extractMany', from: 'response', parser: 'json',
  path: 'list', fields: { encoded: 'value' }, saveAs: 'encodedItems' });
const htmlMany = Object.freeze({ type: 'extractMany', from: 'response', parser: 'html',
  selector: 'a[data-encoded]', fields: { encoded: 'data-encoded' },
  saveAs: 'encodedItems' });
const decode = Object.freeze({ type: 'decodeBase64Many', from: 'encodedItems',
  field: 'encoded', targetField: 'url', saveAs: 'decodedItems' });
const httpsOnly = Object.freeze({ type: 'filterMany', from: 'decodedItems',
  field: 'url', urlProtocol: 'https', saveAs: 'httpsItems' });
const emit = Object.freeze({ type: 'emitEach', from: 'httpsItems', url: '{item.url}' });
const flow = (extract = jsonMany, decoder = decode) =>
  [request, extract, decoder, httpsOnly, emit];
const encoded = (value, variant = 'base64') => Buffer.from(value, 'utf8').toString(variant);

const fakeSources = async (list, workflow = flow(), options = {}) => {
  let calls = 0;
  const provider = createHttpWorkflowSourceProvider({ id: 'base64_fixture',
    enabled: true, baseUrl: 'https://source.example.test', workflow, maxSteps: 8,
    maxCandidates: options.maxCandidates || 8,
    http: { request: async () => {
      calls += 1;
      return { ok: true, status: 200, url: 'https://source.example.test/item/item-1',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ list })) };
    } } });
  return { candidates: await provider.getSources(media, { providerMediaRef: ref }), calls };
};

test('Base64, Base64URL, missing padding and multiple values decode in order', async () => {
  const urlA = 'https://media.example.test/a.m3u8';
  const urlB = 'https://media.example.test/\u083e.m3u8';
  const urlC = `${urlA}?x=1`;
  const base64url = encoded(urlB, 'base64url');
  assert.match(base64url, /[-_]/);
  assert.match(encoded(urlB), /[+/]/);
  assert.match(encoded(urlC), /=+$/);
  const { candidates, calls } = await fakeSources([
    { value: encoded(urlA) }, { value: encoded(urlB) }, { value: base64url },
    { value: encoded(urlC).replace(/=+$/, '') },
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(candidates.map(({ url }) => url),
    [urlA, urlB, urlB, urlC]);
});

test('malformed Base64 and invalid UTF-8 are skipped individually', async () => {
  const valid = 'https://media.example.test/valid.m3u8';
  const { candidates } = await fakeSources([
    { value: 'not base64!' }, { value: '/w==' }, { value: 'YR==' },
    { value: 'a' }, { value: encoded('https://media.example.test/\nunsafe') },
    { value: encoded(valid) }, { value: 123 },
  ]);
  assert.deepEqual(candidates.map(({ url }) => url), [valid]);
});

test('empty collection and invalid URL produce no candidates', async () => {
  assert.deepEqual((await fakeSources([])).candidates, []);
  assert.deepEqual((await fakeSources([{ value: encoded('not a URL') }])).candidates, []);
});

test('decoded byte limit defaults to 2048 and can be raised only to 4096', async () => {
  const longUrl = `https://media.example.test/${'a'.repeat(2100)}`;
  const list = [{ value: encoded(longUrl) }];
  assert.deepEqual((await fakeSources(list)).candidates, []);
  assert.equal((await fakeSources(list, flow(jsonMany,
    { ...decode, maxDecodedBytes: 4096 }))).candidates.length, 1);
  assert.equal(normalizeWorkflow(flow(jsonMany,
    { ...decode, maxDecodedBytes: 4097 }), 8), null);
});

test('maxItems, maxCandidates and immutable/idempotent normalization', async () => {
  const normalized = normalizeWorkflow(flow(), 8);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.equal(normalized[2].maxItems, 8);
  assert.equal(normalized[2].maxDecodedBytes, 2048);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[2]), true);
  const list = Array.from({ length: 12 }, (_, index) => ({
    value: encoded(`https://media.example.test/${index}.m3u8`),
  }));
  assert.equal((await fakeSources(list)).candidates.length, 8);
  assert.equal((await fakeSources(list, flow(), { maxCandidates: 2 })).candidates.length, 2);
  assert.equal(normalizeWorkflow(flow(jsonMany, { ...decode, maxItems: 33 }), 8), null);
});

test('decoded collection remains safe for filterMany, bindOne and emitEach', async () => {
  const target = 'https://media.example.test/a.m3u8';
  const binding = { type: 'bindOne', from: 'httpsItems', fields: { chosenUrl: 'url' } };
  const workflow = [request, jsonMany, decode, httpsOnly, binding,
    { type: 'emit', url: '{chosenUrl}' }];
  assert.deepEqual((await fakeSources([{ value: encoded(target) }], workflow))
    .candidates.map(({ url }) => url), [target]);
  const filtered = await fakeSources([{ value: encoded('http://media.example.test/a.m3u8') },
    { value: encoded(target) }]);
  assert.deepEqual(filtered.candidates.map(({ url }) => url), [target]);
});

test('schema fails closed for invalid field, source, protocol and limits', () => {
  for (const step of [
    { ...decode, from: 'unknown' }, { ...decode, field: 'missing' },
    { ...decode, targetField: '__proto__' }, { ...decode, targetField: 'encoded' },
    { ...decode, maxDecodedBytes: 0 }, { ...decode, maxItems: 0 },
    { ...decode, extra: 'not-allowed' },
  ]) assert.equal(normalizeWorkflow([request, jsonMany, step, httpsOnly, emit], 8), null);
  assert.equal(normalizeWorkflow([request, jsonMany, decode,
    { ...httpsOnly, urlProtocol: 'ftp' }, emit], 8), null);
  assert.equal(normalizeWorkflow([request, jsonMany, decode,
    { ...httpsOnly, equals: 'x' }, emit], 8), null);
  assert.throws(() => createHttpWorkflowSourceProvider({ id: 'base64_fixture',
    enabled: true, baseUrl: 'https://source.example.test', workflow: [request, decode],
    maxSteps: 8 }), { code: ERROR_CODES.INVALID_WORKFLOW });
});

test('HTML attribute extraction is bounded and rejects unsafe config', async () => {
  assert.equal(normalizeWorkflow(flow({ ...htmlMany,
    fields: { encoded: '__proto__' } }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...htmlMany, selector: 'script *' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...htmlMany, maxItems: 33 }), 8), null);
  const html = `<a data-encoded="${encoded('https://media.example.test/a.m3u8')}"></a>` +
    '<a></a>' +
    `<a data-encoded="${encoded('https://media.example.test/b.m3u8')}"></a>`;
  const provider = createHttpWorkflowSourceProvider({ id: 'base64_fixture',
    enabled: true, baseUrl: 'https://source.example.test', maxSteps: 8,
    workflow: flow(htmlMany),
    http: { request: async () => ({ ok: true, status: 200,
      url: 'https://source.example.test/item/item-1',
      headers: { 'content-type': 'text/html' }, body: Buffer.from(html) }) } });
  assert.deepEqual((await provider.getSources(media, { providerMediaRef: ref }))
    .map(({ url }) => url),
  ['https://media.example.test/a.m3u8', 'https://media.example.test/b.m3u8']);
});

test('catalog accepts and revalidates the bounded Base64 workflow', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'base64_fixture',
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', maxSteps: 8,
      workflow: flow(htmlMany) }] }), env: {} });
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extractMany', 'decodeBase64Many', 'filterMany', 'emitEach']);
});

test('local HTTP fixture: request → HTML attributes → decode → HTTPS → emitEach',
  async (t) => {
    const seen = [];
    const server = http.createServer((incoming, response) => {
      seen.push(incoming.url);
      if (incoming.url !== '/item/item-1') { response.writeHead(404).end(); return; }
      const urls = ['https://media.example.test/a.m3u8',
        'http://media.example.test/rejected.m3u8',
        'https://media.example.test/b.m3u8'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(urls.map((url) => `<a data-encoded="${encoded(url)}"></a>`).join(''));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const provider = createHttpWorkflowSourceProvider({ id: 'base64_fixture',
      enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`,
      workflow: flow(htmlMany), maxSteps: 8,
      http: createSafeHttpClient({ allowPrivateNetworks: true }) });
    const candidates = await provider.getSources(media, { providerMediaRef: ref });
    assert.deepEqual(seen, ['/item/item-1']);
    assert.deepEqual(candidates.map(({ url }) => url),
      ['https://media.example.test/a.m3u8', 'https://media.example.test/b.m3u8']);
  });
