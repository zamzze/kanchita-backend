'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { createStreamRanker } =
  require('../src/modules/streams/resolverV2/ranking/streamRanker');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { createResolutionPipeline } =
  require('../src/modules/streams/resolverV2/resolutionPipeline');

const master = fs.readFileSync(path.join(__dirname, 'fixtures', 'streams',
  'master-simple.m3u8'), 'utf8');
const mediaContext = {
  contentType: 'movie', contentId: 'direct-engine-fixture', tmdbId: 550,
  title: 'Direct Engine Fixture',
};
let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.local').pathname;
    if (pathname === '/master.m3u8') {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end(master);
    }
    if (pathname === '/html') {
      response.setHeader('content-type', 'text/html');
      return response.end('<html>synthetic embed</html>');
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const createHarness = (legacyFallback) => {
  const direct = createDirectHlsResolver({
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 300 }),
    timeoutMs: 250,
  });
  return createResolverEngine({
    registry: createResolverRegistry([direct]), legacyFallback, timeoutMs: 500,
  });
};

test('local end-to-end path resolves HLS without legacy fallback or browser', async () => {
  let legacyCalls = 0;
  const result = await createHarness({
    resolve: async () => { legacyCalls += 1; return []; },
  }).resolve({
    mediaContext,
    candidates: [{ providerId: 'local_fixture', url: `${baseUrl}/master.m3u8` }],
  });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].protocol, 'hls');
  assert.equal(result.streams[0].providerId, 'local_fixture');
  assert.equal(result.streams[0].resolverId, 'direct_hls');
  assert.equal(result.streams[0].validated, true);
  assert.equal(result.streams[0].hlsInfo.isMaster, true);
  assert.equal(result.usedLegacyFallback, false);
  assert.equal(legacyCalls, 0);
});

test('local HTML candidate produces empty direct result and invokes fake legacy only', async () => {
  let legacyCalls = 0;
  const result = await createHarness({
    resolve: async () => { legacyCalls += 1; return []; },
  }).resolve({
    mediaContext,
    candidates: [{ providerId: 'local_fixture', url: `${baseUrl}/html` }],
  });
  assert.deepEqual(result.streams, []);
  assert.equal(result.usedLegacyFallback, true);
  assert.equal(legacyCalls, 1);
  assert.deepEqual(result.attempts.map(({ resolverId, outcome }) => ({ resolverId, outcome })), [
    { resolverId: 'direct_hls', outcome: 'empty' },
    { resolverId: 'legacy_browser', outcome: 'empty' },
  ]);
});

test('same HLS URL preserves distinct language options and deterministic ranking', async () => {
  const url = `${baseUrl}/master.m3u8`;
  const candidates = [
    { providerId: 'local_fixture', url, languageHint: 'en',
      qualityHint: '720p', metadata: { source: 'fixture', variant: '1' } },
    { providerId: 'local_fixture', url, languageHint: 'es-419',
      qualityHint: '1080p', metadata: { source: 'fixture', variant: '2' } },
  ];
  const result = await createHarness().resolve({ mediaContext, candidates });
  assert.equal(result.nodesSkippedVisited, 0);
  assert.deepEqual(result.streams.map(({ audioLanguage, quality, metadata }) => [
    audioLanguage, quality, metadata.source, metadata.variant,
  ]), [
    ['en', '720p', 'fixture', '1'],
    ['es-419', '1080p', 'fixture', '2'],
  ]);
  const ranker = createStreamRanker();
  assert.deepEqual(ranker.rank(result.streams).map(({ audioLanguage }) => audioLanguage),
    ['es-419', 'en']);
  assert.deepEqual(ranker.rank([...result.streams].reverse())
    .map(({ audioLanguage }) => audioLanguage), ['es-419', 'en']);
});

test('identical HLS options collapse while same-language variants survive', async () => {
  const base = { providerId: 'local_fixture', url: `${baseUrl}/master.m3u8`,
    languageHint: 'es-419', metadata: { source: 'fixture', variant: '1' } };
  const identical = await createHarness().resolve({
    mediaContext, candidates: [base, { ...base, metadata: { variant: '1', source: 'fixture' } }],
  });
  assert.equal(identical.streams.length, 1);
  assert.equal(identical.nodesSkippedVisited, 1);

  const distinct = await createHarness().resolve({ mediaContext, candidates: [
    base, { ...base, metadata: { source: 'fixture', variant: '2' } },
  ] });
  assert.deepEqual(distinct.streams.map(({ metadata }) => metadata.variant), ['1', '2']);
});

test('local source manager to engine retains same-URL language variants', async () => {
  const url = `${baseUrl}/master.m3u8`;
  const source = { descriptor: { id: 'local_aggregator', active: true,
    priority: 50, supportsMovies: true, supportsEpisodes: true, languages: [],
    strategy: 'http', timeoutMs: 500, maxCandidates: 8 },
  getSources: async () => [
    { url, languageHint: 'en', metadata: { variant: '1' } },
    { url, languageHint: 'es-419', metadata: { variant: '2' } },
    { url, languageHint: 'en', metadata: { variant: '1' } },
  ] };
  const pipeline = createResolutionPipeline({
    sourceProviderManager: createSourceProviderManager({
      registry: createSourceProviderRegistry([source]),
    }),
    resolverEngine: createHarness(),
    ranker: createStreamRanker(),
  });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(result.sourceTrace.candidateCount, 2);
  assert.deepEqual(result.streams.map(({ audioLanguage, metadata }) =>
    [audioLanguage, metadata.variant, metadata.sourcePriority]), [
    ['es-419', '2', 50], ['en', '1', 50],
  ]);
  assert.equal(result.selection.selected.audioLanguage, 'es-419');
});
