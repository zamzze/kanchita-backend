'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, ERROR_CODES,
  HARD_MAX_STEPS, extractText } =
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

const movie = Object.freeze({ contentType: 'movie', contentId: 'fixture-movie',
  tmdbId: 550, title: 'Fixture' });
const episode = Object.freeze({ contentType: 'episode', contentId: 'fixture-episode',
  tmdbId: 900, season: 2, episode: 3, title: 'Fixture S2E3' });
const mapping = (media, externalId) => Object.freeze({ mappingId: 1,
  providerId: 'workflow_a', region: 'global', contentType: media.contentType,
  tmdbId: media.tmdbId, externalId, seasonNumber: media.season ?? null,
  episodeNumber: media.episode ?? null, providerTitle: null, providerSlug: null,
  matchMethod: 'manual', matchConfidence: 100, metadata: {}, lastVerifiedAt: null });

const workflows = Object.freeze({
  JSON_LIST_TO_STREAMS: Object.freeze([
    { type: 'request', method: 'GET', path: '/api/list/{externalId}', saveAs: 'response' },
    { type: 'extractMany', from: 'response', parser: 'json', path: 'list',
      fields: { url: 'embed_url' }, saveAs: 'items', maxItems: 8 },
    { type: 'emitEach', from: 'items', url: '{item.url}' },
  ]),
  EXACT_EPISODE_API_CHAIN: Object.freeze([
    { type: 'request', method: 'POST', path: '/api/episodes',
      form: { item_id: '{externalId}', season_number: '{season}' }, saveAs: 'response' },
    { type: 'extractMany', from: 'response', parser: 'json', path: '$',
      fields: { number: 'number', permalink: 'permalink' },
      saveAs: 'episodes', maxItems: 8 },
    { type: 'filterMany', from: 'episodes', field: 'number', equals: '{episode}',
      saveAs: 'selected', maxItems: 1 },
    { type: 'bindOne', from: 'selected', fields: { episodePermalink: 'permalink' } },
    { type: 'request', method: 'GET', path: '/episode/{episodePermalink}',
      saveAs: 'episodeResponse' },
    { type: 'extract', from: 'episodeResponse', parser: 'json', path: 'url',
      saveAs: 'hls' },
    { type: 'emit', url: '{hls}' },
  ]),
  HTML_SINGLE_EMBED: Object.freeze([
    { type: 'request', method: 'GET', path: '/html/{externalId}', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: 'iframe',
      attribute: 'src', saveAs: 'embedUrl' },
    { type: 'emit', url: '{embedUrl}' },
  ]),
  EMBEDDED_JSON_ARRAY_IN_HTML: Object.freeze([
    { type: 'request', method: 'GET', path: '/html/embedded', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'text', start: '"sources":',
      end: ',"other":', saveAs: 'capturedJson' },
    { type: 'extractMany', from: 'capturedJson', parser: 'json', path: 'sources',
      fields: { url: 'file' }, saveAs: 'items' },
    { type: 'emitEach', from: 'items', url: '{item.url}' },
  ]),
  MULTI_STEP_COLLECTION_FANOUT: Object.freeze([
    { type: 'request', method: 'GET', path: '/api/qualities', saveAs: 'response' },
    { type: 'extractMany', from: 'response', parser: 'json', path: 'qualities',
      fields: { qualityId: 'id' }, saveAs: 'qualities' },
    // No request-per-item step exists; these remaining steps describe the desired flow only.
    { type: 'requestEach', from: 'qualities', path: '/quality/{item.qualityId}',
      saveAs: 'qualityResponses' },
    { type: 'extractMany', from: 'qualityResponses', parser: 'json', path: 'links',
      fields: { linkId: 'id' }, saveAs: 'links' },
    { type: 'requestEach', from: 'links', path: '/link/{item.linkId}',
      saveAs: 'linkResponses' },
    { type: 'extractMany', from: 'linkResponses', parser: 'json', path: 'streams',
      fields: { url: 'url' }, saveAs: 'streams' },
    { type: 'emitEach', from: 'streams', url: '{item.url}' },
  ]),
});

const conformance = Object.freeze({
  JSON_LIST_TO_STREAMS: Object.freeze({ family: 'JSON_LIST_TO_STREAMS',
    status: 'SUPPORTED', stepsRepresentable: 3,
    firstMissingCapability: null, additionalMissingCapabilities: [],
    workflowStepCount: 3, maxStepsBlocked: false, embedCandidates: 2, validatedStreams: 2 }),
  EXACT_EPISODE_API_CHAIN: Object.freeze({ family: 'EXACT_EPISODE_API_CHAIN',
    status: 'SUPPORTED', stepsRepresentable: 7,
    firstMissingCapability: null, additionalMissingCapabilities: [],
    workflowStepCount: 7, maxStepsBlocked: false, embedCandidates: 1, validatedStreams: 1 }),
  HTML_SINGLE_EMBED: Object.freeze({ family: 'HTML_SINGLE_EMBED',
    status: 'SUPPORTED', stepsRepresentable: 3,
    firstMissingCapability: null, additionalMissingCapabilities: [],
    workflowStepCount: 3, maxStepsBlocked: false, embedCandidates: 1, validatedStreams: 1 }),
  EMBEDDED_JSON_ARRAY_IN_HTML: Object.freeze({ family: 'EMBEDDED_JSON_ARRAY_IN_HTML',
    status: 'PARTIALLY_SUPPORTED',
    stepsRepresentable: 2, firstMissingCapability: 'parse_captured_json_to_collection',
    additionalMissingCapabilities: [], workflowStepCount: 4, maxStepsBlocked: false,
    embedCandidates: 0, validatedStreams: 0 }),
  MULTI_STEP_COLLECTION_FANOUT: Object.freeze({ family: 'MULTI_STEP_COLLECTION_FANOUT',
    status: 'PARTIALLY_SUPPORTED',
    stepsRepresentable: 2, firstMissingCapability: 'bounded_request_per_item',
    additionalMissingCapabilities: ['nested_response_aggregation'],
    workflowStepCount: 7, maxStepsBlocked: false,
    embedCandidates: 0, validatedStreams: 0 }),
});

const embeddedHtml = (base) => `<script type="application/json">{"sources":` +
  JSON.stringify([{ file: `${base}/hls/a.m3u8` },
    { file: `${base}/hls/b.m3u8` }]) + ',"other":null}</script>';

const fixtureServer = async (t) => {
  const requests = [];
  const server = http.createServer((incoming, response) => {
    requests.push({ method: incoming.method, path: incoming.url });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (incoming.url === '/api/list/movie-a') return json({ list: [
      { embed_url: `${base}/hls/a.m3u8` }, { embed_url: `${base}/hls/b.m3u8` },
    ] });
    if (incoming.url === '/api/episodes' && incoming.method === 'POST') {
      let body = '';
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)),
          { item_id: 'series-123', season_number: '2' });
        json([1, 2, 3].map((n) => ({ number: n, permalink: `episode-${n}` })));
      });
      return undefined;
    }
    if (incoming.url === '/episode/episode-3') return json({ url: `${base}/hls/episode.m3u8` });
    if (incoming.url === '/html/movie-c') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<main><iframe src="/hls/c.m3u8"></iframe></main>');
      return undefined;
    }
    if (incoming.url === '/html/embedded') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(embeddedHtml(base));
      return undefined;
    }
    if (incoming.url === '/api/qualities') return json({ qualities: [
      { id: 'low' }, { id: 'high' },
    ] });
    if (incoming.url.startsWith('/hls/')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n');
      return undefined;
    }
    response.writeHead(404).end();
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
};

const mappedSource = async ({ baseUrl, workflow, mediaContext, externalId, client }) => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global', baseUrl,
      maxSteps: HARD_MAX_STEPS, workflow }] }), env: {} });
  assert.equal(catalog.sources.length, 1);
  const runtime = buildResolverV2CatalogRuntime({ catalog, http: client,
    hlsResolver: { resolve: async () => [] },
    mappingResolver: { resolve: async () => [mapping(mediaContext, externalId)] } });
  return runtime.sources[0].getSources(mediaContext, {});
};

const validate = (client, mediaContext, candidates) => createResolverEngine({
  registry: createResolverRegistry([createDirectHlsResolver({ httpClient: client })]),
}).resolve({ mediaContext, candidates });

test('conformance matrix has exactly five bounded families and no maxSteps-only blocker', () => {
  assert.deepEqual(Object.keys(conformance), Object.keys(workflows));
  for (const [family, result] of Object.entries(conformance)) {
    assert.equal(result.family, family);
    assert.equal(result.workflowStepCount, workflows[family].length);
    assert.equal(result.maxStepsBlocked, result.workflowStepCount > HARD_MAX_STEPS);
    assert.ok(result.stepsRepresentable <= result.workflowStepCount);
    assert.ok(['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED'].includes(result.status));
  }
});

test('A JSON_LIST_TO_STREAMS: exact mapped GET emits two validated HLS streams', async (t) => {
  const fixture = await fixtureServer(t);
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  assert.ok(normalizeWorkflow(workflows.JSON_LIST_TO_STREAMS, HARD_MAX_STEPS));
  const candidates = await mappedSource({ baseUrl: fixture.baseUrl,
    workflow: workflows.JSON_LIST_TO_STREAMS, mediaContext: movie,
    externalId: 'movie-a', client });
  const result = await validate(client, movie, candidates);
  assert.equal(candidates.length, conformance.JSON_LIST_TO_STREAMS.embedCandidates);
  assert.equal(result.streams.length, conformance.JSON_LIST_TO_STREAMS.validatedStreams);
  assert.ok(result.streams.every(({ validated, protocol }) => validated && protocol === 'hls'));
  assert.deepEqual(fixture.requests, [
    { method: 'GET', path: '/api/list/movie-a' },
    { method: 'GET', path: '/hls/a.m3u8' },
    { method: 'GET', path: '/hls/b.m3u8' },
  ]);
});

test('B EXACT_EPISODE_API_CHAIN: only S2E3 receives exact-item request', async (t) => {
  const fixture = await fixtureServer(t);
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  assert.ok(normalizeWorkflow(workflows.EXACT_EPISODE_API_CHAIN, HARD_MAX_STEPS));
  const candidates = await mappedSource({ baseUrl: fixture.baseUrl,
    workflow: workflows.EXACT_EPISODE_API_CHAIN, mediaContext: episode,
    externalId: 'series-123', client });
  const result = await validate(client, episode, candidates);
  assert.equal(candidates.length, conformance.EXACT_EPISODE_API_CHAIN.embedCandidates);
  assert.equal(result.streams.length, conformance.EXACT_EPISODE_API_CHAIN.validatedStreams);
  assert.equal(result.streams[0].validated, true);
  assert.deepEqual(fixture.requests, [
    { method: 'POST', path: '/api/episodes' },
    { method: 'GET', path: '/episode/episode-3' },
    { method: 'GET', path: '/hls/episode.m3u8' },
  ]);
});

test('C HTML_SINGLE_EMBED: existing iframe selector resolves one validated HLS', async (t) => {
  const fixture = await fixtureServer(t);
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  assert.ok(normalizeWorkflow(workflows.HTML_SINGLE_EMBED, HARD_MAX_STEPS));
  const candidates = await mappedSource({ baseUrl: fixture.baseUrl,
    workflow: workflows.HTML_SINGLE_EMBED, mediaContext: movie,
    externalId: 'movie-c', client });
  const result = await validate(client, movie, candidates);
  assert.equal(candidates.length, conformance.HTML_SINGLE_EMBED.embedCandidates);
  assert.equal(result.streams.length, conformance.HTML_SINGLE_EMBED.validatedStreams);
  assert.equal(result.streams[0].validated, true);
  assert.deepEqual(fixture.requests, [
    { method: 'GET', path: '/html/movie-c' },
    { method: 'GET', path: '/hls/c.m3u8' },
  ]);
});

test('D EMBEDDED_JSON_ARRAY_IN_HTML: capture works, but captured scalar is not a JSON response',
  async (t) => {
    const fixture = await fixtureServer(t);
    const captured = extractText(embeddedHtml(fixture.baseUrl), '"sources":', ',"other":');
    assert.equal(JSON.parse(captured).length, 2);
    assert.equal(normalizeWorkflow(workflows.EMBEDDED_JSON_ARRAY_IN_HTML, HARD_MAX_STEPS), null);
    const prefix = workflows.EMBEDDED_JSON_ARRAY_IN_HTML.slice(0, 2);
    assert.ok(normalizeWorkflow(prefix, HARD_MAX_STEPS));
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const candidates = await mappedSource({ baseUrl: fixture.baseUrl, workflow: prefix,
      mediaContext: movie, externalId: 'unused', client });
    assert.deepEqual(candidates, []);
    assert.deepEqual(fixture.requests, [{ method: 'GET', path: '/html/embedded' }]);
    assert.equal(conformance.EMBEDDED_JSON_ARRAY_IN_HTML.firstMissingCapability,
      'parse_captured_json_to_collection');
  });

test('E MULTI_STEP_COLLECTION_FANOUT: array extraction works but cannot request per item',
  async (t) => {
    const fixture = await fixtureServer(t);
    assert.equal(normalizeWorkflow(workflows.MULTI_STEP_COLLECTION_FANOUT,
      HARD_MAX_STEPS), null);
    const prefix = workflows.MULTI_STEP_COLLECTION_FANOUT.slice(0, 2);
    assert.ok(normalizeWorkflow(prefix, HARD_MAX_STEPS));
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    assert.deepEqual(await mappedSource({ baseUrl: fixture.baseUrl, workflow: prefix,
      mediaContext: movie, externalId: 'unused', client }), []);
    assert.deepEqual(fixture.requests, [{ method: 'GET', path: '/api/qualities' }]);
    const attemptedScalarPath = [...prefix,
      { type: 'bindOne', from: 'qualities', fields: { qualityId: 'qualityId' } },
      { type: 'request', method: 'GET', path: '/quality/{qualityId}', saveAs: 'quality' }];
    const provider = createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
      baseUrl: fixture.baseUrl, http: client, maxSteps: HARD_MAX_STEPS,
      workflow: attemptedScalarPath });
    await assert.rejects(provider.getSources(movie,
      { providerMediaRef: mapping(movie, 'unused') }),
    { code: ERROR_CODES.AMBIGUOUS_COLLECTION });
    assert.deepEqual(fixture.requests, [
      { method: 'GET', path: '/api/qualities' },
      { method: 'GET', path: '/api/qualities' },
    ]);
    assert.equal(conformance.MULTI_STEP_COLLECTION_FANOUT.firstMissingCapability,
      'bounded_request_per_item');
  });
