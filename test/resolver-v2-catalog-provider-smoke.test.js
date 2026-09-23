'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { normalizeCatalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogSchema');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');
const { DEFAULT_CATALOG_PATH, DIAGNOSTIC_TMDB_ID, createCatalogProviderSmoke,
  formatCatalogProviderSmoke, parseCatalogProviderSmokeArgs } =
  require('../src/modules/streams/resolverV2/diagnostics/catalogProviderSmoke');

const EXTERNAL_ID = '7bc04dcc-1bde-4350-99a2-8d67fc1534e5';
const CATALOG = JSON.parse(fs.readFileSync(DEFAULT_CATALOG_PATH, 'utf8'));
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

const fixture = async (options = {}) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    if (request.url === `/api/v1/videos/${EXTERNAL_ID}`) {
      response.writeHead(options.apiStatus || 200, { 'content-type': 'application/json' });
      response.end(options.apiBody === undefined
        ? JSON.stringify({ streamingPlaylists: [{ playlistUrl:
          `http://127.0.0.1:${server.address().port}/master.m3u8` }] }) : options.apiBody);
      return;
    }
    if (request.url === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(MEDIA);
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { paths, origin, close: () => new Promise((resolve) => server.close(resolve)) };
};

const harness = (origin, options = {}) => createCatalogProviderSmoke({
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 1000 }),
  readFile: () => JSON.stringify({ ...CATALOG,
    sources: CATALOG.sources.map((entry) => ({ ...entry, baseUrl: origin })) }),
  mappingStore: options.mappingStore,
  timeoutMs: 3000,
});
const run = (smoke) => smoke.run({ providerId: 'peertube_public_demo', externalId: EXTERNAL_ID });

test('diagnostic parses only explicit provider and external UUID', () => {
  assert.equal(parseCatalogProviderSmokeArgs(['--provider', 'peertube_public_demo',
    '--external-id', EXTERNAL_ID]).ok, true);
  assert.equal(parseCatalogProviderSmokeArgs(['--provider', 'bad/url',
    '--external-id', EXTERNAL_ID]).ok, false);
  assert.equal(parseCatalogProviderSmokeArgs(['--provider', 'peertube_public_demo',
    '--external-id', 'not-an-id']).ok, false);
});

test('real catalog workflow maps exact ID and validates local HLS without discovery', async () => {
  const local = await fixture();
  const lookups = [];
  const mappingStore = { findActiveMappings: async (identity) => {
    lookups.push(identity);
    return [{ id: 7, provider_id: identity.providerId, region: identity.region,
      content_type: identity.contentType, tmdb_id: identity.tmdbId,
      season_number: null, episode_number: null, external_id: EXTERNAL_ID,
      match_method: 'manual', match_confidence: 100, metadata: {} }];
  } };
  try {
    const result = await run(harness(local.origin, { mappingStore }));
    assert.equal(result.status, 'RESOLUTION_READY');
    assert.equal(result.provider, 'peertube_public_demo');
    assert.equal(result.configLoaded, true);
    assert.equal(result.mappingResolved, true);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.protocol, 'hls');
    assert.equal(result.validated, true);
    assert.equal(result.apiRequestCount, 1);
    assert.equal(result.hlsRequestCount, 1);
    assert.equal(result.requestCount, 2);
    assert.deepEqual(local.paths, [`/api/v1/videos/${EXTERNAL_ID}`, '/master.m3u8']);
    assert.deepEqual(lookups, [{ providerId: 'peertube_public_demo', region: 'global',
      contentType: 'movie', tmdbId: DIAGNOSTIC_TMDB_ID,
      seasonNumber: null, episodeNumber: null }]);
    assert.equal(Object.isFrozen(result), true);
  } finally { await local.close(); }
});

test('loaded catalog emits a normalized immutable EmbedCandidate via mapped runtime', async () => {
  const local = await fixture();
  try {
    const catalog = loadResolverV2Catalog({ enabled: true, filePath: DEFAULT_CATALOG_PATH,
      readFile: () => JSON.stringify({ ...CATALOG, sources: CATALOG.sources.map(
        (entry) => ({ ...entry, baseUrl: local.origin })) }), env: {} });
    assert.equal(catalog.loaded, true);
    const diagnostic = normalizeCatalog({ version: 1,
      sources: [{ ...catalog.sources[0], enabled: true }], resolvers: [] });
    const runtime = buildResolverV2CatalogRuntime({ catalog: { ...diagnostic, loaded: true },
      http: createSafeHttpClient({ allowPrivateNetworks: true }),
      mappingResolver: { resolve: async () => [{ mappingId: 1,
        providerId: 'peertube_public_demo', region: 'global', contentType: 'movie',
        tmdbId: DIAGNOSTIC_TMDB_ID, externalId: EXTERNAL_ID,
        seasonNumber: null, episodeNumber: null, metadata: {} }] }, env: {} });
    assert.equal(runtime.sources.length, 1);
    const candidates = await runtime.sources[0].getSources({ contentType: 'movie',
      contentId: 'diagnostic', tmdbId: DIAGNOSTIC_TMDB_ID, title: 'Diagnostic' });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'peertube_public_demo');
    assert.equal(candidates[0].url, `${local.origin}/master.m3u8`);
    assert.equal(Object.isFrozen(candidates[0]), true);
    assert.deepEqual(local.paths, [`/api/v1/videos/${EXTERNAL_ID}`]);
  } finally { await local.close(); }
});

test('missing mapping causes zero network requests', async () => {
  const local = await fixture();
  try {
    const result = await run(harness(local.origin,
      { mappingStore: { findActiveMappings: async () => [] } }));
    assert.equal(result.status, 'RESOLUTION_EMPTY');
    assert.equal(result.mappingResolved, false);
    assert.equal(result.requestCount, 0);
    assert.deepEqual(local.paths, []);
  } finally { await local.close(); }
});

test('malformed item and hard HTTP failure do not emit candidates', async () => {
  for (const options of [{ apiBody: '{bad json' }, { apiBody: '{}' },
    { apiStatus: 500, apiBody: '{}' }]) {
    const local = await fixture(options);
    try {
      const result = await run(harness(local.origin));
      assert.notEqual(result.status, 'RESOLUTION_READY');
      assert.equal(result.candidateCount, 0);
      assert.equal(result.validated, false);
      assert.equal(result.requestCount, 1);
      assert.deepEqual(local.paths, [`/api/v1/videos/${EXTERNAL_ID}`]);
    } finally { await local.close(); }
  }
});

test('diagnostic output never includes URL, UUID, headers, or response data', async () => {
  const local = await fixture();
  try {
    const text = formatCatalogProviderSmoke(await run(harness(local.origin)));
    assert.match(text, /status=RESOLUTION_READY/);
    assert.doesNotMatch(text, /127\.0\.0\.1|master\.m3u8|api\/v1\/videos|7bc04dcc|authorization|cookie/i);
    assert.doesNotMatch(formatCatalogProviderSmoke(await run(harness(local.origin)), true),
      /127\.0\.0\.1|master\.m3u8|api\/v1\/videos|7bc04dcc|authorization|cookie/i);
  } finally { await local.close(); }
});
