'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, ERROR_CODES } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');

const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/api/provider/{externalId}', saveAs: 'response' });
const many = Object.freeze({ type: 'extractMany', from: 'response', parser: 'json',
  path: 'list', fields: { url: 'embed_url', title: 'title' }, saveAs: 'items' });
const each = Object.freeze({ type: 'emitEach', from: 'items', url: '{item.url}' });
const workflow = (extract = many, emit = each) => [request, extract, emit];
const media = Object.freeze({ contentType: 'movie', contentId: 'fixture-1',
  tmdbId: 550, title: 'Fixture' });
const ref = Object.freeze({ mappingId: 1, providerId: 'workflow_a', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'external-123', seasonNumber: null,
  episodeNumber: null, providerTitle: null, providerSlug: null,
  matchMethod: 'manual', matchConfidence: 100, metadata: {}, lastVerifiedAt: null });
const fakeProvider = (payload, options = {}) => createHttpWorkflowSourceProvider({
  id: 'workflow_a', enabled: true, baseUrl: 'https://source.example.test',
  workflow: options.workflow || workflow(), maxCandidates: options.maxCandidates || 8,
  http: { request: async () => ({ ok: true, status: 200,
    url: 'https://source.example.test/api/provider/external-123',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)) }) },
});
const sources = (provider) => provider.getSources(media, { providerMediaRef: ref });

test('extractMany and emitEach normalize immutably and revalidate through the same schema', () => {
  const raw = workflow();
  const original = structuredClone(raw);
  const normalized = normalizeWorkflow(raw, 8);
  assert.ok(normalized);
  assert.equal(normalized[1].maxItems, 8);
  assert.equal(normalized[1].type, 'extractMany');
  assert.equal(normalized[2].type, 'emitEach');
  assert.equal(Object.isFrozen(normalized[1].fields), true);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(raw, original);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
});

test('JSON array emits valid items in stable order and skips malformed items individually', async () => {
  const payload = { list: [
    { embed_url: 'https://media.example.test/a.m3u8', title: 'A' },
    { embed_url: 'ftp://invalid.test/b', title: 'B' },
    { embed_url: 'https://media.example.test/c.m3u8', title: 'C' },
    { embed_url: 'https://media.example.test/missing.m3u8' },
    null,
  ] };
  const candidates = await sources(fakeProvider(payload));
  assert.deepEqual(candidates.map(({ url }) => url), [
    'https://media.example.test/a.m3u8', 'https://media.example.test/c.m3u8',
  ]);
  assert.equal(Object.isFrozen(candidates), true);
  assert.equal(Object.isFrozen(candidates[0]), true);
});

test('missing or non-array collection path is an extraction miss', async () => {
  assert.deepEqual(await sources(fakeProvider({ other: [] })), []);
  assert.deepEqual(await sources(fakeProvider({ list: {} })), []);
});

test('maxItems bounds inspected items, hard max is 32, and maxCandidates remains absolute',
  async () => {
    const list = Array.from({ length: 40 }, (_, n) => ({
      embed_url: `https://media.example.test/${n}.m3u8`, title: String(n),
    }));
    assert.equal((await sources(fakeProvider({ list }))).length, 8);
    assert.equal((await sources(fakeProvider({ list },
      { workflow: workflow({ ...many, maxItems: 32 }), maxCandidates: 32 }))).length, 32);
    assert.equal((await sources(fakeProvider({ list }, { maxCandidates: 2 }))).length, 2);
    assert.equal(normalizeWorkflow(workflow({ ...many, maxItems: 33 }), 8), null);
    assert.equal(normalizeWorkflow(workflow({ ...many, maxItems: 0 }), 8), null);
  });

test('unsafe paths, prototype keys, dynamic templates and too many fields are rejected', () => {
  const invalid = [
    { ...many, path: 'list.*' },
    { ...many, path: 'list.{externalId}' },
    { ...many, path: 'list.__proto__' },
    { ...many, fields: { url: 'constructor' } },
    { ...many, fields: JSON.parse('{"__proto__":"url"}') },
    { ...many, fields: Object.fromEntries(Array.from({ length: 17 },
      (_, n) => [`field${n}`, 'embed_url'])) },
    { ...many, fields: {} },
  ];
  for (const extract of invalid) assert.equal(normalizeWorkflow(workflow(extract), 8), null);
  assert.equal(normalizeWorkflow(workflow(many,
    { ...each, url: '{externalId}' }), 8), null);
  assert.equal(normalizeWorkflow(workflow(many,
    { ...each, url: '{item.nested.url}' }), 8), null);
});

test('emitEach accepts only extractMany output and unknown item fields skip items', async () => {
  const scalar = { type: 'extract', from: 'response', parser: 'json',
    path: 'value', saveAs: 'items' };
  assert.equal(normalizeWorkflow(workflow(scalar), 8), null);
  assert.equal(normalizeWorkflow([request, each], 8), null);
  const candidates = await sources(fakeProvider({ list: [{
    embed_url: 'https://media.example.test/a.m3u8', title: 'A',
  }] }, { workflow: workflow(many, { ...each, url: '{item.unknown}' }) }));
  assert.deepEqual(candidates, []);
});

test('oversized scalar discards only its item; bounded response rejects oversized body',
  async () => {
    const candidates = await sources(fakeProvider({ list: [
      { embed_url: 'x'.repeat(4097), title: 'bad' },
      { embed_url: 'https://media.example.test/good.m3u8', title: 'good' },
    ] }));
    assert.deepEqual(candidates.map(({ url }) => url),
      ['https://media.example.test/good.m3u8']);
    const provider = createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
      baseUrl: 'https://source.example.test', workflow: workflow(), maxBytes: 10,
      http: { request: async () => ({ ok: true, status: 200,
        headers: { 'content-type': 'application/json' }, body: Buffer.alloc(11) }) } });
    await assert.rejects(sources(provider), { code: ERROR_CODES.CAPTURE_TOO_LARGE });
  });

test('existing scalar extract and emit retain their original path', async () => {
  const scalarFlow = [request, { type: 'extract', from: 'response', parser: 'json',
    path: 'url', saveAs: 'streamUrl' }, { type: 'emit', url: '{streamUrl}' }];
  const result = await sources(fakeProvider({ url: 'https://media.example.test/a.m3u8' },
    { workflow: scalarFlow }));
  assert.equal(result.length, 1);
});

test('mapped catalog accepts extractMany and emitEach without an alternate schema', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{
      id: 'workflow_a', type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', workflow: workflow(),
    }] }), env: {} });
  assert.equal(catalog.sources.length, 1);
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extractMany', 'emitEach']);
});

test('offline mapping to catalog workflow to ResolverEngine validates two HLS candidates',
  async (t) => {
    const requests = [];
    const server = http.createServer((incoming, response) => {
      requests.push(incoming.url);
      if (incoming.url === '/api/provider/external-123') {
        const base = `http://127.0.0.1:${server.address().port}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ list: [
          { embed_url: `${base}/a.m3u8`, title: 'A' },
          { embed_url: `${base}/b.m3u8`, title: 'B' },
        ] }));
      } else if (['/a.m3u8', '/b.m3u8'].includes(incoming.url)) {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n');
      } else response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
      readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
        type: 'mapped_http_workflow', enabled: true, region: 'global', baseUrl,
        workflow: workflow() }] }), env: {} });
    const runtime = buildResolverV2CatalogRuntime({ catalog, http: client,
      hlsResolver: { resolve: async () => [] },
      mappingResolver: { resolve: async () => [ref] } });
    const candidates = await runtime.sources[0].getSources(media, {});
    assert.equal(candidates.length, 2);
    const engine = createResolverEngine({ registry: createResolverRegistry([
      createDirectHlsResolver({ httpClient: client }),
    ]) });
    const result = await engine.resolve({ mediaContext: media, candidates });
    assert.equal(result.streams.length, 2);
    assert.deepEqual(result.streams.map(({ validated }) => validated), [true, true]);
    assert.deepEqual(result.streams.map(({ protocol }) => protocol), ['hls', 'hls']);
    assert.deepEqual(requests, ['/api/provider/external-123', '/a.m3u8', '/b.m3u8']);
  });
