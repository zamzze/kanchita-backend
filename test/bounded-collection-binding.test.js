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

const media = Object.freeze({ contentType: 'episode', contentId: 'fixture-2-3',
  tmdbId: 900, season: 2, episode: 3, title: 'Fixture episode' });
const ref = Object.freeze({ mappingId: 1, providerId: 'workflow_a', region: 'global',
  contentType: 'episode', tmdbId: 900, externalId: 'series-123',
  seasonNumber: 2, episodeNumber: 3, providerTitle: null, providerSlug: null,
  matchMethod: 'manual', matchConfidence: 100, metadata: {}, lastVerifiedAt: null });
const request = Object.freeze({ type: 'request', method: 'POST', path: '/api/episodes',
  form: { item_id: '{externalId}', season_number: '{season}' }, saveAs: 'response' });
const extract = Object.freeze({ type: 'extractMany', from: 'response', parser: 'json',
  path: '$', fields: { number: 'number', permalink: 'permalink' },
  saveAs: 'episodes', maxItems: 32 });
const filter = Object.freeze({ type: 'filterMany', from: 'episodes', field: 'number',
  equals: '{episode}', saveAs: 'selectedEpisodes', maxItems: 1 });
const bind = Object.freeze({ type: 'bindOne', from: 'selectedEpisodes',
  fields: { episodePermalink: 'permalink' } });
const emit = Object.freeze({ type: 'emit',
  url: 'https://media.example.test/{episodePermalink}.m3u8' });
const flow = (binding = bind) => [request, extract, filter, binding, emit];
const episode = (number, permalink = `episode-${number}`) => ({ number, permalink });
const makeProvider = (payload, workflow = flow(), onRequest = null) =>
  createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
    baseUrl: 'https://source.example.test', workflow, maxSteps: 8,
    http: { request: async (method, url) => {
      onRequest?.(method, url);
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)) };
    } },
  });
const sources = (provider) => provider.getSources(media, { providerMediaRef: ref });

test('bindOne normalizes immutably and revalidates through the existing workflow schema', () => {
  const raw = flow();
  const original = structuredClone(raw);
  const normalized = normalizeWorkflow(raw, 8);
  assert.ok(normalized);
  assert.equal(normalized[3].type, 'bindOne');
  assert.equal(Object.isFrozen(normalized[3].fields), true);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.deepEqual(raw, original);
});

test('exactly one filtered item binds a scalar for the existing emit template', async () => {
  const result = await sources(makeProvider([episode(1), episode(3)]));
  assert.deepEqual(result.map(({ url }) => url),
    ['https://media.example.test/episode-3.m3u8']);
});

test('zero items are a workflow miss; no subsequent request runs', async () => {
  const requests = [];
  const workflow = [request, extract, filter, bind,
    { type: 'request', method: 'GET', path: '/episode/{episodePermalink}', saveAs: 'item' }];
  assert.deepEqual(await sources(makeProvider([episode(1)], workflow,
    (_method, url) => requests.push(new URL(url).pathname))), []);
  assert.deepEqual(requests, ['/api/episodes']);
});

test('more than one item fails explicitly even when filter maxItems is one', async () => {
  await assert.rejects(sources(makeProvider([episode(3, 'first'), episode(3, 'second')])),
    { code: ERROR_CODES.AMBIGUOUS_COLLECTION });
  await assert.rejects(sources(makeProvider([episode(3), episode(1)],
    [request, { ...extract, maxItems: 1 }, filter, bind, emit])),
    { code: ERROR_CODES.AMBIGUOUS_COLLECTION });
});

test('bindOne accepts only provenance-safe extractMany or filterMany collections', () => {
  for (const from of ['response', 'externalId', 'unknown']) {
    assert.equal(normalizeWorkflow(flow({ ...bind, from }), 8), null);
  }
  assert.ok(normalizeWorkflow([request, extract,
    { ...bind, from: 'episodes' }, emit], 8));
});

test('source field must exist and destination must be a safe static name', () => {
  for (const fields of [
    { episodePermalink: 'missing' }, { 'bad.name': 'permalink' },
    { constructor: 'permalink' }, { episodePermalink: '__proto__' }, {},
    Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`value${n}`, 'permalink'])),
  ]) assert.equal(normalizeWorkflow(flow({ ...bind, fields }), 8), null);
});

test('bindOne never overwrites protected or previously assigned variables', () => {
  for (const name of ['externalId', 'contentType', 'tmdbId', 'season', 'episode',
    'region', 'response', 'episodes', 'selectedEpisodes']) {
    assert.equal(normalizeWorkflow(flow({ ...bind, fields: { [name]: 'permalink' } }), 8), null);
  }
  assert.equal(normalizeWorkflow([request, extract, filter, bind,
    { type: 'extract', from: 'response', parser: 'json', path: 'other',
      saveAs: 'episodePermalink' }], 8), null);
});

test('object, array and oversized source values cannot bind', async () => {
  for (const value of [{ path: 'episode-3' }, ['episode-3'], 'x'.repeat(4097)]) {
    assert.deepEqual(await sources(makeProvider([episode(3, value)])), []);
  }
});

test('bound scalar is available to a later request using existing template rendering',
  async () => {
    const requests = [];
    const workflow = [request, extract, filter, bind,
      { type: 'request', method: 'GET', path: '/episode/{episodePermalink}', saveAs: 'item' },
      { type: 'extract', from: 'item', parser: 'json', path: 'url', saveAs: 'hls' },
      { type: 'emit', url: '{hls}' }];
    const provider = createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
      baseUrl: 'https://source.example.test', workflow, maxSteps: 8,
      http: { request: async (method, url) => {
        requests.push([method, new URL(url).pathname]);
        const payload = method === 'POST' ? [episode(1), episode(3)]
          : { url: 'https://media.example.test/ready.m3u8' };
        return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(payload)) };
      } },
    });
    assert.equal((await sources(provider))[0].url,
      'https://media.example.test/ready.m3u8');
    assert.deepEqual(requests, [['POST', '/api/episodes'], ['GET', '/episode/episode-3']]);
  });

test('source collection is reusable without mutation and existing emitEach remains valid',
  async () => {
    const workflow = [request, extract, filter, bind, emit,
      { type: 'emitEach', from: 'episodes', url: 'https://media.example.test/{item.permalink}.m3u8' }];
    const payload = [episode(1), episode(3)];
    const before = structuredClone(payload);
    const result = await sources(makeProvider(payload, workflow));
    assert.deepEqual(payload, before);
    assert.deepEqual(result.map(({ url }) => url), [
      'https://media.example.test/episode-3.m3u8',
      'https://media.example.test/episode-1.m3u8',
      'https://media.example.test/episode-3.m3u8',
    ]);
  });

test('mapped catalog accepts bindOne without a second schema', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', maxSteps: 8, workflow: flow() }] }), env: {} });
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extractMany', 'filterMany', 'bindOne', 'emit']);
});

test('offline exact S2E3 flow makes only two requests and validates one HLS', async (t) => {
  const requests = [];
  const server = http.createServer((incoming, response) => {
    requests.push({ method: incoming.method, path: incoming.url });
    if (incoming.url === '/api/episodes' && incoming.method === 'POST') {
      let body = '';
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)),
          { item_id: 'series-123', season_number: '2' });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([episode(1), episode(2), episode(3)]));
      });
    } else if (incoming.url === '/episode/episode-3') {
      const base = `http://127.0.0.1:${server.address().port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: `${base}/master.m3u8` }));
    } else if (incoming.url === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n');
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workflow = [request, extract, filter, bind,
    { type: 'request', method: 'GET', path: '/episode/{episodePermalink}', saveAs: 'item' },
    { type: 'extract', from: 'item', parser: 'json', path: 'url', saveAs: 'hls' },
    { type: 'emit', url: '{hls}' }];
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global', baseUrl,
      maxSteps: 8, workflow }] }), env: {} });
  const runtime = buildResolverV2CatalogRuntime({ catalog, http: client,
    hlsResolver: { resolve: async () => [] },
    mappingResolver: { resolve: async () => [ref] } });
  const candidates = await runtime.sources[0].getSources(media, {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, `${baseUrl}/master.m3u8`);
  const engine = createResolverEngine({ registry: createResolverRegistry([
    createDirectHlsResolver({ httpClient: client }),
  ]) });
  const result = await engine.resolve({ mediaContext: media, candidates });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].protocol, 'hls');
  assert.equal(result.streams[0].validated, true);
  assert.deepEqual(requests, [
    { method: 'POST', path: '/api/episodes' },
    { method: 'GET', path: '/episode/episode-3' },
    { method: 'GET', path: '/master.m3u8' },
  ]);
});
