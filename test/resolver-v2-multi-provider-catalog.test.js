'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://catalog:catalog@127.0.0.1:5432/catalog';
process.env.JWT_SECRET ||= 'catalog-e2e-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'catalog-e2e-refresh-secret';
process.env.TMDB_API_KEY ||= 'catalog-e2e-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');
const { createV2HealthStore } =
  require('../src/modules/streams/resolverV2/health/v2HealthStore');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');

const mediaContext = { contentType: 'movie', contentId: 'fixture', tmdbId: 10,
  title: 'Fixture' };
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const sourceEntry = (id, baseUrl, priority = 100) => ({ id, type: 'configured_http',
  enabled: true, priority, baseUrl });
const resolverEntry = (id, prefix) => ({ id, type: 'configured_http', enabled: true,
  priority: 2000, domains: ['127.0.0.1'], pathPrefixes: [prefix] });

test('three catalog sources route through direct and two descriptor resolvers and rank Latino',
  async (t) => {
    const manifests = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
    });
    const serverResolvers = await listen((request, response) => {
      const latino = request.url.startsWith('/b/');
      json(response, { streams: [{ url: `${manifests.url}/${latino ? 'latino' : 'es'}.m3u8`,
        protocol: 'hls', quality: latino ? '720p' : '1080p',
        audioLanguage: latino ? 'es-419' : 'es', providerId: 'remote_fake',
        resolverId: 'remote_fake' }] });
    });
    const sourceA = await listen((_request, response) => json(response, { sources: [{
      url: `${manifests.url}/english.m3u8`, language: 'en', quality: '1080p',
      providerId: 'remote_fake',
    }] }));
    const sourceB = await listen((_request, response) => json(response, { sources: [{
      url: `${serverResolvers.url}/b/resolve/10`, providerId: 'remote_fake',
    }] }));
    const sourceC = await listen((_request, response) => json(response, { sources: [{
      url: `${serverResolvers.url}/c/resolve/10`, providerId: 'remote_fake',
    }] }));
    t.after(() => Promise.all([manifests, serverResolvers, sourceA, sourceB, sourceC]
      .map(({ server }) => close(server))));
    const catalog = { version: 1, sources: [
      sourceEntry('source_a', sourceA.url), sourceEntry('source_b', sourceB.url),
      sourceEntry('source_c', sourceC.url),
    ], resolvers: [resolverEntry('resolver_b', '/b/'), resolverEntry('resolver_c', '/c/')] };
    const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
      primaryTimeoutMs: 3000, timeoutMs: 3000, catalogEnabled: true,
      catalogPath: 'catalog.json', catalogReadFile: () => JSON.stringify(catalog),
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
      logger: { log: () => {} } });
    const resolved = await runtime.pipeline.resolve(mediaContext);
    assert.equal(resolved.streams.length, 3);
    assert.deepEqual(new Set(resolved.streams.map((stream) => stream.providerId)),
      new Set(['source_a', 'source_b', 'source_c']));
    assert.equal(resolved.streams.find((stream) => stream.providerId === 'source_b').resolverId,
      'resolver_b');
    assert.equal(resolved.streams.find((stream) => stream.providerId === 'source_c').resolverId,
      'resolver_c');
    assert.equal(resolved.selection.selected.providerId, 'source_b');
    assert.equal(resolved.selection.selected.audioLanguage, 'es-419');

    let legacyCalls = 0;
    const processor = createStreamProcessor({
      db: { query: async () => {} }, resolverExecutor: { shutdown: async () => {} },
      validator: async () => ({ valid: true }), findContent: async () => ({
        tmdb_id: 10, title: 'Fixture',
      }), primaryEnabled: true, primaryRolloutPercent: 100,
      primaryResolver: runtime.primaryResolver,
      providerManager: { resolve: async () => { legacyCalls += 1;
        return { url: 'https://legacy.example.test/master.m3u8' }; } },
      lifecycle: { readUsableCache: async () => ({ streams: null }),
        resolveAndPersist: async (_type, _id, content, resolve) => resolve({
          ...mediaContext, tmdbId: content.tmdb_id, title: content.title,
        }) }, stats: { recordReady: async () => {} },
      primaryMetrics: { increment: async () => {} }, logger: { log: () => {}, warn: () => {} },
    });
    const primary = await processor({ content_type: 'movie', content_id: 'fixture',
      job_type: 'resolve' });
    assert.equal(primary.provider, 'source_b');
    assert.equal(legacyCalls, 0);
  });

test('catalog sources retain manager concurrency and per-provider candidate caps', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fakeHttp = {
    head: async () => { throw new Error('not expected'); },
    get: async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ sources: [] })) };
    },
  };
  const catalog = { version: 1, sources: Array.from({ length: 10 }, (_, index) =>
    sourceEntry(`source_${index}`, `https://source-${index}.example.test`)), resolvers: [] };
  const runtime = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(catalog), httpClient: fakeHttp,
    timeoutMs: 1000, healthEnabled: false });
  const result = await runtime.sourceProviderManager.getSources(mediaContext);
  assert.equal(result.candidates.length, 0);
  assert.equal(calls, 10);
  assert.ok(peak <= 3);

  fakeHttp.get = async () => ({ ok: true, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ sources: Array.from({ length: 20 }, (_, index) => ({
      url: `https://media.example.test/${index}.m3u8`,
    })) })) });
  const cappedCatalog = { version: 1, sources: [
    { ...sourceEntry('cap_a', 'https://cap-a.example.test'), maxCandidates: 1 },
    { ...sourceEntry('cap_b', 'https://cap-b.example.test'), maxCandidates: 1 },
  ] };
  const capped = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify(cappedCatalog), httpClient: fakeHttp,
    timeoutMs: 1000, healthEnabled: false });
  assert.equal((await capped.sourceProviderManager.getSources(mediaContext)).candidates.length, 2);
});

test('catalog input order cannot change registry order or ranked selection', async () => {
  const makeHttp = () => ({
    head: async () => { throw new Error('HEAD is not expected for direct HLS'); },
    get: async (url) => {
      if (url.includes('/sources/movie/')) {
        const latino = url.includes('source-b.example.test');
        return { ok: true, status: 200, url,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ sources: [{
            url: `https://media.example.test/${latino ? 'b' : 'a'}.m3u8`,
            language: latino ? 'es-419' : 'en', quality: latino ? '720p' : '1080p',
          }] })) };
      }
      return { ok: true, status: 200, url,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body: Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n') };
    },
  });
  const entries = [sourceEntry('source_b', 'https://source-b.example.test'),
    sourceEntry('source_a', 'https://source-a.example.test')];
  const resolve = async (sources) => createShadowPipeline({ catalogEnabled: true,
    catalogPath: 'catalog.json', catalogReadFile: () => JSON.stringify({ version: 1, sources }),
    httpClient: makeHttp(), healthEnabled: false }).pipeline.resolve(mediaContext);
  const first = await resolve(entries);
  const second = await resolve([...entries].reverse());
  assert.deepEqual(first.streams.map(({ providerId }) => providerId),
    second.streams.map(({ providerId }) => providerId));
  assert.equal(first.selection.selected.providerId, 'source_b');
  assert.equal(second.selection.selected.providerId, 'source_b');
});

test('catalog entry limits cannot disable the global ResolverEngine stream cap', async () => {
  const httpClient = {
    head: async () => { throw new Error('HEAD is not expected for direct HLS'); },
    get: async (url) => {
      if (url.includes('/sources/movie/')) {
        return { ok: true, status: 200, url,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ sources: Array.from({ length: 20 }, (_, index) => ({
            url: `https://media.example.test/${index}.m3u8`,
          })) })) };
      }
      return { ok: true, status: 200, url,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body: Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n') };
    },
  };
  const runtime = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1, sources: [{
      ...sourceEntry('source_a', 'https://source-a.example.test'), maxCandidates: 32,
    }] }), httpClient, healthEnabled: false });
  const result = await runtime.pipeline.resolve(mediaContext);
  assert.equal(result.streams.length, 8);
});
test('one failing catalog source does not prevent a valid sibling or legacy fallback', async (t) => {
  const manifest = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const failed = await listen((_request, response) => json(response, { error: true }, 500));
  const invalid = await listen((_request, response) => json(response, { sources: [{ url: 'bad' }] }));
  const valid = await listen((_request, response) => json(response, { sources: [{
    url: `${manifest.url}/valid.m3u8`, language: 'es-419',
  }] }));
  t.after(() => Promise.all([manifest, failed, invalid, valid]
    .map(({ server }) => close(server))));
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 2000, timeoutMs: 2000, catalogEnabled: true,
    catalogPath: 'catalog.json', catalogReadFile: () => JSON.stringify({ version: 1,
      sources: [sourceEntry('source_a', failed.url), sourceEntry('source_b', invalid.url),
        sourceEntry('source_c', valid.url)] }),
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true }), logger: { log: () => {} } });
  const result = await runtime.primaryResolver.resolve(mediaContext);
  assert.equal(result.status, 'accepted');
  assert.equal(result.selected.providerId, 'source_c');
});
test('all empty catalog sources fall back to legacy exactly once', async () => {
  let sourceCalls = 0;
  let legacyCalls = 0;
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    primaryTimeoutMs: 1000, timeoutMs: 1000, catalogEnabled: true,
    catalogPath: 'catalog.json', catalogReadFile: () => JSON.stringify({ version: 1,
      sources: [sourceEntry('source_a', 'https://source.example.test')] }),
    httpClient: { head: async () => {}, get: async () => { sourceCalls += 1;
      return { ok: true, headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"sources":[]}') }; } }, healthEnabled: false });
  const processor = createStreamProcessor({
    db: { query: async () => {} }, resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }), findContent: async () => ({
      tmdb_id: 10, title: 'Fixture',
    }), primaryEnabled: true, primaryRolloutPercent: 100,
    primaryResolver: runtime.primaryResolver,
    providerManager: { resolve: async () => { legacyCalls += 1;
      return { url: 'https://legacy.example.test/master.m3u8' }; } },
    lifecycle: { readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        ...mediaContext, tmdbId: content.tmdb_id, title: content.title,
      }) }, stats: { recordReady: async () => {} },
    primaryMetrics: { increment: async () => {} }, logger: { log: () => {}, warn: () => {} },
  });
  const result = await processor({ content_type: 'movie', content_id: 'fixture',
    job_type: 'resolve' });
  assert.equal(sourceCalls, 1);
  assert.equal(legacyCalls, 1);
  assert.equal(result.url, 'https://legacy.example.test/master.m3u8');
});
test('catalog control group and open primary guard execute no configured source', async () => {
  let sourceCalls = 0;
  let legacyCalls = 0;
  const fakeHttp = { head: async () => {}, get: async () => { sourceCalls += 1;
    return { ok: true, headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"sources":[]}') }; } };
  const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
    catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1,
      sources: [sourceEntry('source_a', 'https://source.example.test')] }),
    httpClient: fakeHttp, healthEnabled: false });
  const guard = require('../src/modules/streams/resolverV2/health/primaryRuntimeGuard')
    .createPrimaryRuntimeGuard({ minimumAttempts: 3, windowSize: 3,
      failureRateThreshold: 50, timeoutRateThreshold: 40, cooldownMs: 10_000 });
  const make = (rolloutPercent, primaryRuntimeGuard) => createStreamProcessor({
    db: { query: async () => {} }, resolverExecutor: { shutdown: async () => {} },
    validator: async () => ({ valid: true }), findContent: async () => ({
      tmdb_id: 10, title: 'Fixture',
    }), primaryEnabled: true, primaryRolloutPercent: rolloutPercent,
    primaryRuntimeGuard, primaryResolver: runtime.primaryResolver,
    providerManager: { resolve: async () => { legacyCalls += 1;
      return { url: 'https://legacy.example.test/master.m3u8' }; } },
    lifecycle: { readUsableCache: async () => ({ streams: null }),
      resolveAndPersist: async (_type, _id, content, resolve) => resolve({
        ...mediaContext, tmdbId: content.tmdb_id, title: content.title,
      }) }, stats: { recordReady: async () => {} },
    primaryMetrics: { increment: async () => {} }, logger: { log: () => {}, warn: () => {} },
  });
  await make(0)({ content_type: 'movie', content_id: 'fixture', job_type: 'resolve' });
  assert.equal(sourceCalls, 0);
  guard.recordOutcome('failed'); guard.recordOutcome('failed'); guard.recordOutcome('failed');
  await make(100, guard)({ content_type: 'movie', content_id: 'fixture', job_type: 'resolve' });
  assert.equal(sourceCalls, 0);
  assert.equal(legacyCalls, 2);
});

test('catalog source and resolver health remain isolated by local component ID', async () => {
  const sourceCalls = [];
  const sourceHealth = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10_000 });
  sourceHealth.canAttempt('source', 'source_a');
  sourceHealth.recordFailure('source', 'source_a', { errorCode: 'SOURCE_FAILED' });
  const sourceRuntime = createShadowPipeline({ catalogEnabled: true, catalogPath: 'catalog.json',
    catalogReadFile: () => JSON.stringify({ version: 1, sources: [
      sourceEntry('source_a', 'https://a.example.test'),
      sourceEntry('source_b', 'https://b.example.test'),
    ] }), healthStore: sourceHealth,
    httpClient: { head: async () => {}, get: async (url) => { sourceCalls.push(url);
      return { ok: true, headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"sources":[]}') }; } } });
  await sourceRuntime.sourceProviderManager.getSources(mediaContext);
  assert.equal(sourceCalls.some((url) => url.includes('a.example.test')), false);
  assert.equal(sourceCalls.some((url) => url.includes('b.example.test')), true);

  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => JSON.stringify({ version: 1, resolvers: [
      resolverEntry('resolver_a', '/a/'), resolverEntry('resolver_b', '/b/'),
    ] }), env: {} });
  const resolverHealth = createV2HealthStore({ failureThreshold: 1, cooldownMs: 10_000 });
  resolverHealth.canAttempt('resolver', 'resolver_a');
  resolverHealth.recordFailure('resolver', 'resolver_a', { errorCode: 'RESOLVER_FAILED' });
  const built = buildResolverV2CatalogRuntime({ catalog, env: {},
    http: { get: async () => ({ ok: true,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"streams":[{"url":"https://media.example.test/x.m3u8",' +
        '"protocol":"hls"}]}') }) },
    hlsResolver: { resolve: async (candidate) => [{
      url: candidate.url, protocol: 'hls', providerId: candidate.providerId,
      resolverId: 'direct_hls', headers: {}, quality: null, audioLanguage: null,
      subtitleLanguage: null, expiresAt: null, validated: true, latencyMs: 0,
      hlsInfo: null, metadata: { resolverStrategy: 'direct' },
    }] } });
  const engine = createResolverEngine({ registry: createResolverRegistry(built.resolvers),
    healthStore: resolverHealth, timeoutMs: 1000 });
  const result = await engine.resolve({ mediaContext, candidates: [
    { providerId: 'source', url: 'https://127.0.0.1/a/item', headers: {} },
    { providerId: 'source', url: 'https://127.0.0.1/b/item', headers: {} },
  ] });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].resolverId, 'resolver_b');
});
