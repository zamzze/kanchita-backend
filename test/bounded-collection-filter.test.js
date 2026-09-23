'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow } =
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

const media = Object.freeze({ contentType: 'episode', contentId: 'fixture-2-3',
  tmdbId: 900, season: 2, episode: 3, title: 'Fixture episode' });
const ref = Object.freeze({ mappingId: 1, providerId: 'workflow_a', region: 'global',
  contentType: 'episode', tmdbId: 900, externalId: 'provider-series-123',
  seasonNumber: 2, episodeNumber: 3, providerTitle: null, providerSlug: null,
  matchMethod: 'manual', matchConfidence: 100, metadata: {}, lastVerifiedAt: null });
const request = Object.freeze({ type: 'request', method: 'POST', path: '/api/episodes',
  form: { item_id: '{externalId}', season_number: '{season}' }, saveAs: 'response' });
const extract = Object.freeze({ type: 'extractMany', from: 'response', parser: 'json',
  path: '$', fields: { episodeNumber: 'episode_number', url: 'stream_url' },
  saveAs: 'episodes', maxItems: 32 });
const filter = Object.freeze({ type: 'filterMany', from: 'episodes',
  field: 'episodeNumber', equals: '{episode}', saveAs: 'selectedEpisodes', maxItems: 1 });
const emit = Object.freeze({ type: 'emitEach', from: 'selectedEpisodes',
  url: '{item.url}' });
const flow = (selection = filter, output = emit) => [request, extract, selection, output];
const provider = (payload, workflow = flow(), maxCandidates = 8) =>
  createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
    baseUrl: 'https://source.example.test', workflow, maxCandidates,
    maxSteps: 8,
    http: { request: async () => ({ ok: true, status: 200,
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)) }) },
  });
const getSources = (payload, workflow, maxCandidates) =>
  provider(payload, workflow, maxCandidates).getSources(media, { providerMediaRef: ref });
const item = (episodeNumber, suffix) => ({ episode_number: episodeNumber,
  stream_url: `https://media.example.test/${suffix}.m3u8` });

test('filterMany normalizes immutably, is idempotent and uses only existing variables', () => {
  const input = flow();
  const copy = structuredClone(input);
  const normalized = normalizeWorkflow(input, 8);
  assert.ok(normalized);
  assert.equal(normalized[2].type, 'filterMany');
  assert.equal(normalized[2].maxItems, 1);
  assert.equal(Object.isFrozen(normalized[2]), true);
  assert.deepEqual(input, copy);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.equal(normalizeWorkflow(flow({ ...filter, equals: '{unknown}' }), 8), null);
});

test('filterMany selects exact strings without fuzzy or coercive matching', async () => {
  const selected = await getSources([item('3', 'exact'), item('03', 'leading-zero'),
    item('3 ', 'space'), item('13', 'suffix')]);
  assert.deepEqual(selected.map(({ url }) => url),
    ['https://media.example.test/exact.m3u8']);
});

test('canonical safe integers compare to rendered episode without loose equality', async () => {
  const selected = await getSources([item(1, 'one'), item(2, 'two'), item(3, 'three')]);
  assert.deepEqual(selected.map(({ url }) => url),
    ['https://media.example.test/three.m3u8']);
  assert.deepEqual(await getSources([item(3.5, 'fraction')]), []);
});

test('no match returns empty, matches preserve order and obey maxItems', async () => {
  assert.deepEqual(await getSources([item(1, 'one'), item(2, 'two')]), []);
  const matches = Array.from({ length: 15 }, (_, n) => item(3, String(n)));
  const selection = { ...filter, maxItems: 8 };
  assert.deepEqual((await getSources(matches, flow(selection))).map(({ url }) => url),
    matches.slice(0, 8).map((entry) => entry.stream_url));
  assert.equal((await getSources(matches, flow({ ...filter, maxItems: 32 }), 2)).length, 2);
  assert.equal(normalizeWorkflow(flow({ ...filter, maxItems: 33 }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, maxItems: 0 }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, maxItems: undefined }), 8)[2].maxItems, 8);
});

test('filter source must be a safe collection and field must come from extractMany', () => {
  assert.equal(normalizeWorkflow(flow({ ...filter, from: 'response' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, from: 'externalId' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, field: 'missing' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, field: '__proto__' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, saveAs: 'episode' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, equals: '{item.url}' }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...filter, predicate: 'contains' }), 8), null);
});

test('object, array and null values are not comparable or emitted', async () => {
  const selected = await getSources([item({ id: 3 }, 'object'),
    item([3], 'array'), item(null, 'null'), item(3, 'valid')]);
  assert.deepEqual(selected.map(({ url }) => url),
    ['https://media.example.test/valid.m3u8']);
});

test('filterMany may chain into filterMany and emitEach without mutating source', async () => {
  const second = { type: 'filterMany', from: 'selectedEpisodes', field: 'url',
    equals: 'https://media.example.test/b.m3u8', saveAs: 'finalEpisodes' };
  const workflow = [request, extract, { ...filter, maxItems: 8 }, second,
    { ...emit, from: 'finalEpisodes' }, { ...emit, from: 'episodes' }];
  const normalized = normalizeWorkflow(workflow, 8);
  assert.ok(normalized);
  const selected = await getSources([item(3, 'a'), item(3, 'b')], workflow);
  assert.deepEqual(selected.map(({ url }) => url), [
    'https://media.example.test/b.m3u8',
    'https://media.example.test/a.m3u8',
    'https://media.example.test/b.m3u8',
  ]);
});

test('existing extractMany and emitEach still work without filtering', async () => {
  const result = await getSources([item(1, 'one'), item(2, 'two')],
    [request, extract, { ...emit, from: 'episodes' }]);
  assert.deepEqual(result.map(({ url }) => url),
    ['https://media.example.test/one.m3u8', 'https://media.example.test/two.m3u8']);
});

test('mapped catalog accepts exact filter flow through central schema', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', workflow: flow() }] }), env: {} });
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extractMany', 'filterMany', 'emitEach']);
});

test('offline episode POST selects only S2E3 and validates one direct HLS stream', async (t) => {
  const requests = [];
  const server = http.createServer((incoming, response) => {
    requests.push({ method: incoming.method, path: incoming.url });
    if (incoming.url === '/api/episodes' && incoming.method === 'POST') {
      let body = '';
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)),
          { item_id: 'provider-series-123', season_number: '2' });
        const base = `http://127.0.0.1:${server.address().port}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([1, 2, 3].map((number) => ({
          episode_number: number, stream_url: `${base}/${number}.m3u8`,
        }))));
      });
    } else if (incoming.url === '/3.m3u8') {
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
      workflow: flow() }] }), env: {} });
  const runtime = buildResolverV2CatalogRuntime({ catalog, http: client,
    hlsResolver: { resolve: async () => [] },
    mappingResolver: { resolve: async () => [ref] } });
  const candidates = await runtime.sources[0].getSources(media, {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, `${baseUrl}/3.m3u8`);
  const engine = createResolverEngine({ registry: createResolverRegistry([
    createDirectHlsResolver({ httpClient: client }),
  ]) });
  const result = await engine.resolve({ mediaContext: media, candidates });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].validated, true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/episodes' },
    { method: 'GET', path: '/3.m3u8' }]);
});
