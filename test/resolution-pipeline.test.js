'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { createResolutionPipeline } =
  require('../src/modules/streams/resolverV2/resolutionPipeline');

const mediaContext = {
  contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10, title: 'Fixture',
};
const candidate = (suffix = '') => ({
  providerId: 'fixture', url: `https://media.example.test/master${suffix}.m3u8`, headers: {},
});
const stream = {
  url: 'https://media.example.test/master.m3u8', protocol: 'hls', providerId: 'fixture',
  resolverId: 'fake', headers: {}, expiresAt: null, latencyMs: 1, validated: true,
  quality: null, audioLanguage: null, subtitleLanguage: null, hlsInfo: null, metadata: null,
};

test('pipeline passes one or several sources to the engine and separates traces', async () => {
  const seen = [];
  const pipeline = createResolutionPipeline({
    sourceProviderManager: {
      getSources: async () => ({
        candidates: [candidate(), candidate('-two')],
        trace: { providersAttempted: 2, candidateCount: 2 },
      }),
    },
    resolverEngine: {
      resolve: async (input) => {
        seen.push(input);
        return { streams: [stream], attempts: [{ resolverId: 'fake' }],
          usedLegacyFallback: false, durationMs: 1 };
      },
    },
  });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].candidates.length, 2);
  assert.deepEqual(result.streams, [stream]);
  assert.deepEqual(result.sourceTrace, { providersAttempted: 2, candidateCount: 2 });
  assert.deepEqual(result.resolverTrace, {
    attempts: [{ resolverId: 'fake' }], usedLegacyFallback: false, durationMs: 1,
  });
});

test('zero sources skip the resolver and preserve a coherent empty trace', async () => {
  let resolverCalls = 0;
  const pipeline = createResolutionPipeline({
    sourceProviderManager: { getSources: async () => ({
      candidates: [], trace: { providersFailed: 1, candidateCount: 0 },
    }) },
    resolverEngine: { resolve: async () => { resolverCalls += 1; } },
  });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(result.streams, []);
  assert.equal(result.sourceTrace.providersFailed, 1);
  assert.deepEqual(result.resolverTrace, {
    attempts: [], usedLegacyFallback: false, durationMs: 0,
  });
  assert.equal(result.selection, null);
});

test('optional ranker orders streams and exposes its internal selection', async () => {
  const second = { ...stream, url: 'https://media.example.test/second.m3u8' };
  const selected = { selected: second, ranked: [second, stream], reason: {
    languageTier: 'latino', qualityTier: '1080p', protocolTier: 'hls', validated: true,
  } };
  let rankerCalls = 0;
  const pipeline = createResolutionPipeline({
    sourceProviderManager: { getSources: async () => ({
      candidates: [candidate()], trace: { providersAttempted: 1, candidateCount: 1 },
    }) },
    resolverEngine: { resolve: async () => ({ streams: [stream, second], attempts: [],
      usedLegacyFallback: false, durationMs: 0 }) },
    ranker: { selectBest: (streams) => {
      rankerCalls += 1;
      assert.deepEqual(streams, [stream, second]);
      return selected;
    } },
  });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(rankerCalls, 1);
  assert.deepEqual(result.streams, [second, stream]);
  assert.equal(result.selection, selected);
});

test('a failed source provider does not prevent another provider reaching the engine', async () => {
  const registry = createSourceProviderRegistry([
    {
      descriptor: {
        id: 'broken', active: true, priority: 20, supportsMovies: true,
        supportsEpisodes: true, languages: [], strategy: 'static',
        timeoutMs: 100, maxCandidates: 1,
      },
      getSources: async () => { throw new Error('external failure'); },
    },
    {
      descriptor: {
        id: 'working', active: true, priority: 10, supportsMovies: true,
        supportsEpisodes: true, languages: [], strategy: 'static',
        timeoutMs: 100, maxCandidates: 1,
      },
      getSources: async () => [candidate()],
    },
  ]);
  let seenProvider;
  const pipeline = createResolutionPipeline({
    sourceProviderManager: createSourceProviderManager({ registry }),
    resolverEngine: { resolve: async ({ candidates }) => {
      seenProvider = candidates[0].providerId;
      return { streams: [stream], attempts: [], usedLegacyFallback: false, durationMs: 0 };
    } },
  });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(seenProvider, 'working');
  assert.equal(result.sourceTrace.providersFailed, 1);
  assert.equal(result.streams.length, 1);
});

test('source failures and abort/deadline codes propagate unchanged', async () => {
  for (const code of ['SOURCE_PROVIDER_ABORTED', 'SOURCE_PROVIDER_GLOBAL_TIMEOUT']) {
    const pipeline = createResolutionPipeline({
      sourceProviderManager: { getSources: async () => {
        throw Object.assign(new Error(code), { code });
      } },
      resolverEngine: { resolve: async () => ({ streams: [] }) },
    });
    await assert.rejects(pipeline.resolve(mediaContext), (error) => error.code === code);
  }
});

test('synthetic V2 pipeline resolves SourceProvider to HLS without legacy/browser', async (t) => {
  let legacyCalls = 0;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const localUrl = `http://127.0.0.1:${server.address().port}/master.m3u8`;

  const sourceRegistry = createSourceProviderRegistry([{
    descriptor: {
      id: 'static_fixture', active: true, priority: 100, supportsMovies: true,
      supportsEpisodes: true, languages: ['es-419'], strategy: 'static',
      timeoutMs: 100, maxCandidates: 1,
    },
    getSources: async () => [{ providerId: 'ignored', url: localUrl, headers: {} }],
  }]);
  const sourceManager = createSourceProviderManager({
    registry: sourceRegistry, globalTimeoutMs: 500, providerTimeoutMs: 200,
  });
  const httpClient = createSafeHttpClient({ allowPrivateNetworks: true });
  const directResolver = createDirectHlsResolver({ httpClient, timeoutMs: 200 });
  const engine = createResolverEngine({
    registry: createResolverRegistry([directResolver]),
    legacyFallback: { resolve: async () => { legacyCalls += 1; return []; } },
    timeoutMs: 500,
  });
  const pipeline = createResolutionPipeline({ sourceProviderManager: sourceManager,
    resolverEngine: engine });
  const result = await pipeline.resolve(mediaContext);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].protocol, 'hls');
  assert.equal(result.streams[0].providerId, 'static_fixture');
  assert.equal(result.streams[0].resolverId, 'direct_hls');
  assert.equal(result.streams[0].validated, true);
  assert.equal(legacyCalls, 0);
  assert.equal(result.sourceTrace.providersSucceeded, 1);
  assert.equal(result.resolverTrace.usedLegacyFallback, false);
});

test('pipeline validates dependencies and media input', async () => {
  assert.throws(() => createResolutionPipeline(),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
  const pipeline = createResolutionPipeline({
    sourceProviderManager: { getSources: async () => ({ candidates: [], trace: {} }) },
    resolverEngine: { resolve: async () => ({ streams: [] }) },
  });
  await assert.rejects(pipeline.resolve({}),
    (error) => error.code === 'SOURCE_PROVIDER_INVALID_INPUT');
});
