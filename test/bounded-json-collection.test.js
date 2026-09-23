'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, ERROR_CODES } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');

const media = Object.freeze({ contentType: 'movie', contentId: 'fixture-movie',
  tmdbId: 550, title: 'Fixture' });
const ref = Object.freeze({ mappingId: 1, providerId: 'workflow_a', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'item-123',
  seasonNumber: null, episodeNumber: null, providerTitle: null,
  providerSlug: null, matchMethod: 'manual', matchConfidence: 100,
  metadata: {}, lastVerifiedAt: null });
const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/html/{externalId}', saveAs: 'page' });
const capture = Object.freeze({ type: 'extract', from: 'page', parser: 'text',
  start: 'DATA=', end: ';END', saveAs: 'sourcesJson' });
const parse = Object.freeze({ type: 'parseJsonMany', from: 'sourcesJson', path: '$',
  fields: { url: 'file', quality: 'label' }, saveAs: 'sources' });
const emit = Object.freeze({ type: 'emitEach', from: 'sources',
  url: '{item.url}', qualityHint: '{item.quality}' });
const flow = (step = parse, output = emit) => [request, capture, step, output];
const item = (name, label = '1080p') => ({ file: `https://media.example.test/${name}.m3u8`,
  label });
const makeProvider = (source, workflow = flow(), maxCandidates = 8) =>
  createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
    baseUrl: 'https://source.example.test', workflow, maxSteps: 8,
    maxCandidates, http: { request: async () => ({ ok: true, status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(`<script>DATA=${source};END</script>`) }) },
  });
const sources = (source, workflow, maxCandidates) =>
  makeProvider(source, workflow, maxCandidates).getSources(media, { providerMediaRef: ref });

test('parseJsonMany is immutable, idempotent and defaults to eight items', () => {
  const input = flow();
  const original = structuredClone(input);
  const normalized = normalizeWorkflow(input, 8);
  assert.ok(normalized);
  assert.equal(normalized[2].type, 'parseJsonMany');
  assert.equal(normalized[2].maxItems, 8);
  assert.equal(Object.isFrozen(normalized[2].fields), true);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.deepEqual(input, original);
});

test('root array parses into ordered safe items and preserves quality hints', async () => {
  const result = await sources(JSON.stringify([item('a', '720p'), item('b')]));
  assert.deepEqual(result.map(({ url }) => url), [
    'https://media.example.test/a.m3u8', 'https://media.example.test/b.m3u8',
  ]);
  assert.deepEqual(result.map(({ qualityHint }) => qualityHint), ['720p', '1080p']);
  assert.equal(Object.isFrozen(result), true);
});

test('object path selects only an array using the existing safe JSON path subset',
  async () => {
    const workflow = flow({ ...parse, path: 'data.sources' });
    const result = await sources(JSON.stringify({ data: { sources: [item('nested')] } }),
      workflow);
    assert.equal(result[0].url, 'https://media.example.test/nested.m3u8');
  });

test('invalid JSON, JSON5 and comments are misses rather than executable inputs',
  async () => {
    for (const source of ['not-json', '[{file:"x"}]', '/*comment*/[]', '{"x":}']) {
      assert.deepEqual(await sources(source), []);
    }
  });

test('primitive JSON, missing path and non-array path are misses', async () => {
  for (const source of ['3', 'null', '"text"', '{}']) {
    assert.deepEqual(await sources(source), []);
  }
  assert.deepEqual(await sources('{"other":[]}', flow({ ...parse, path: 'sources' })), []);
  assert.deepEqual(await sources('{"sources":{}}', flow({ ...parse, path: 'sources' })), []);
});

test('maxItems is eight by default, 32 at hard limit, and maxCandidates still applies',
  async () => {
    const payload = JSON.stringify(Array.from({ length: 40 }, (_, n) => item(String(n))));
    assert.equal((await sources(payload)).length, 8);
    assert.equal((await sources(payload, flow({ ...parse, maxItems: 32 }), 32)).length, 32);
    assert.equal((await sources(payload, flow({ ...parse, maxItems: 32 }), 2)).length, 2);
    assert.equal(normalizeWorkflow(flow({ ...parse, maxItems: 33 }), 8), null);
    assert.equal(normalizeWorkflow(flow({ ...parse, maxItems: 0 }), 8), null);
  });

test('invalid individual items are skipped without changing surviving item order', async () => {
  const payload = JSON.stringify([item('first'), { file: 'https://media.example.test/no-label' },
    null, { file: 7, label: '720p' }, item('last')]);
  assert.deepEqual((await sources(payload)).map(({ url }) => url), [
    'https://media.example.test/first.m3u8',
    'https://media.example.test/last.m3u8',
  ]);
});

test('unsafe paths, wildcards, prototype keys and more than 16 fields are rejected', () => {
  const invalid = [
    { ...parse, path: 'sources.*' },
    { ...parse, path: 'sources.__proto__' },
    { ...parse, fields: { url: 'constructor' } },
    { ...parse, fields: JSON.parse('{"__proto__":"file"}') },
    { ...parse, fields: Object.fromEntries(Array.from({ length: 17 },
      (_, n) => [`field${n}`, 'file'])) },
    { ...parse, fields: {} },
    { ...parse, parser: 'json5' },
    { ...parse, path: '{dynamicPath}' },
  ];
  for (const step of invalid) assert.equal(normalizeWorkflow(flow(step), 8), null);
});

test('oversized scalar is rejected by existing capture limit before JSON parsing', async () => {
  await assert.rejects(sources('x'.repeat(4097)),
    { code: ERROR_CODES.CAPTURE_TOO_LARGE });
});

test('source must be a previous scalar variable, not response, collection or unknown',
  async () => {
  for (const from of ['page', 'sources', 'unknown']) {
    assert.equal(normalizeWorkflow(flow({ ...parse, from }), 8), null);
  }
  assert.equal(normalizeWorkflow([request, capture, parse,
    { type: 'parseJsonMany', from: 'sources', path: '$',
      fields: { url: 'file' }, saveAs: 'again' }], 8), null);
  // Built-in numeric media variables are scalar but cannot be parsed as JSON text at runtime.
  assert.deepEqual(await sources(JSON.stringify([item('a')]),
    flow({ ...parse, from: 'tmdbId' })), []);
  });

test('parsed collection is accepted by filterMany, bindOne and emitEach provenance',
  async () => {
    const filter = { type: 'filterMany', from: 'sources', field: 'quality',
      equals: '1080p', saveAs: 'selected', maxItems: 1 };
    const chain = [request, capture, parse, filter,
      { type: 'bindOne', from: 'selected', fields: { chosenUrl: 'url' } },
      { type: 'emit', url: '{chosenUrl}' },
      { type: 'emitEach', from: 'sources', url: '{item.url}' }];
    assert.ok(normalizeWorkflow(chain, 8));
    const result = await sources(JSON.stringify([item('low', '720p'),
      item('high', '1080p')]), chain);
    assert.deepEqual(result.map(({ url }) => url), [
      'https://media.example.test/high.m3u8',
      'https://media.example.test/low.m3u8',
      'https://media.example.test/high.m3u8',
    ]);
  });

test('existing extractMany remains response-only and is not confused with parsed scalar', () => {
  const existing = [
    { type: 'request', method: 'GET', path: '/api', saveAs: 'response' },
    { type: 'extractMany', from: 'response', parser: 'json', path: '$',
      fields: { url: 'file' }, saveAs: 'items' },
    { type: 'emitEach', from: 'items', url: '{item.url}' },
  ];
  assert.ok(normalizeWorkflow(existing, 8));
  assert.equal(normalizeWorkflow(flow({ ...parse, from: 'page' }), 8), null);
});

test('mapped catalog accepts parseJsonMany through its central workflow validator', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', workflow: flow() }] }), env: {} });
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extract', 'parseJsonMany', 'emitEach']);
});
