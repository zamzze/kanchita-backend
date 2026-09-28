'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
const TEST_DB_URL = process.env.TEST_DB_URL;
if (TEST_DB_URL) {
  let destination;
  try { destination = new URL(TEST_DB_URL); } catch {
    throw new Error('TEST_DB_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(destination.protocol) ||
      decodeURIComponent(destination.pathname.slice(1)) !== 'kanchita_resolver_v2_test') {
    throw new Error('TEST_DB_URL_UNSAFE_DATABASE');
  }
  // Any implicit pool constructed by existing modules must also target the test DB.
  process.env.DB_URL = TEST_DB_URL;
} else {
  process.env.DB_URL ||= 'postgresql://archive:archive@127.0.0.1:5432/archive';
}
process.env.JWT_SECRET ||= 'archive-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'archive-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'archive-test-tmdb';

const { runMigrations } = require('../database/migrate');
const { createProviderMediaMappingStore } = require('../src/db/providerMediaMappings.queries');
const { createProviderMediaMappingResolver } =
  require('../src/modules/streams/providerMediaMappingResolver');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } = require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createDirectMp4Resolver } =
  require('../src/modules/streams/resolverV2/resolvers/directMp4Resolver');
const { adaptV2ToLegacyResult } =
  require('../src/modules/streams/resolverV2/v2LegacyResultAdapter');
const { createStreamLifecycle } = require('../src/modules/streams/streamLifecycle');
const { createStreamsService } = require('../src/modules/streams/streams.service');
const configuredPool = require('../src/config/db');

const fixtureId = 'OpenFilm_1';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'),
  Buffer.alloc(52)]);

test('isolated PostgreSQL mapping → Primary MP4 → persisted lifecycle → API service response',
  { skip: TEST_DB_URL ? false : 'TEST_DB_URL is required for PostgreSQL integration' },
  async (t) => {
    assert.equal(decodeURIComponent(new URL(TEST_DB_URL).pathname.slice(1)),
      'kanchita_resolver_v2_test');
    const schema = `archive_test_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Pool({ connectionString: TEST_DB_URL });
    const db = new Pool({ connectionString: TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    const { rows: destination } = await admin.query('SELECT current_database() AS name');
    if (destination[0]?.name !== 'kanchita_resolver_v2_test') {
      await db.end();
      await admin.end();
      throw new Error('TEST_DB_CONNECTED_TO_UNSAFE_DATABASE');
    }
    await admin.query(`CREATE SCHEMA "${schema}"`);
    t.after(async () => {
      await db.end();
      await configuredPool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });
    const migrations = await runMigrations({ pool: db, logger: { log() {} } });
    assert.ok(migrations);
    const { rows: applied } = await db.query('SELECT version FROM schema_migrations');
    assert.ok(applied.some((row) => row.version === '009_provider_media_mappings.sql'));

    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, path: request.url,
        range: request.headers.range || null });
      if (request.url === `/metadata/${fixtureId}`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ metadata: { identifier: fixtureId,
          mediatype: 'movies', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
        files: [{ name: 'film.mp4', format: 'MPEG4', source: 'original',
          size: '2000', height: '720' }] }));
      }
      if (request.url === `/download/${fixtureId}/film.mp4`) {
        response.writeHead(302, { location: '/cdn/film' });
        return response.end();
      }
      if (request.url === '/cdn/film') {
        response.setHeader('content-type', 'video/mp4');
        if (request.method === 'HEAD') return response.end();
        response.writeHead(206);
        return response.end(mp4);
      }
      response.writeHead(404);
      return response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections?.();
      server.close(resolve); }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { rows: movies } = await db.query(`INSERT INTO movies
      (tmdb_id, title, is_published) VALUES (10378, 'Open Film', TRUE)
      RETURNING id, tmdb_id, title`);
    const movie = movies[0];
    const mappingStore = createProviderMediaMappingStore(db);
    await mappingStore.upsertMapping({ providerId: 'internet_archive', region: 'global',
      contentType: 'movie', tmdbId: 10378, externalId: fixtureId,
      matchMethod: 'manual', status: 'active' });
    const mappingResolver = createProviderMediaMappingResolver({ store: mappingStore });
    const catalog = { version: 1, sources: [{ id: 'internet_archive',
      type: 'internet_archive', enabled: true, region: 'global', baseUrl,
      supportsEpisodes: false, maxCandidates: 1 }], resolvers: [] };
    const pipeline = createShadowPipeline({ catalogEnabled: true,
      catalogPath: 'fixture.json', catalogReadFile: () => JSON.stringify(catalog),
      providerMappingResolver: mappingResolver,
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 1500 }),
      primaryEnabled: true, primaryTimeoutMs: 5000, healthEnabled: false });
    const context = { contentType: 'movie', contentId: movie.id,
      tmdbId: movie.tmdb_id, title: movie.title };
    const primary = await pipeline.primaryResolver.resolve(context);
    assert.equal(primary.status, 'accepted');
    assert.equal(primary.selected.protocol, 'mp4');
    assert.equal(primary.selected.validated, true);
    assert.equal(Object.hasOwn(primary.selected.metadata, 'licenseUrl'), false);
    assert.equal(primary.selected.url, `${baseUrl}/download/${fixtureId}/film.mp4`);

    const revalidator = createDirectMp4Resolver({ httpClient:
      createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 1500 }) });
    const lifecycle = createStreamLifecycle({ db, validator: async () => ({ valid: false }),
      logger: { log() {}, warn() {} }, cacheTtlMinutes: 60,
      verifyIntervalMinutes: 10, mp4Validator: async (url, { headers }) => ({
        valid: (await revalidator.resolve({ providerId: 'cached_mp4', url, headers })).length > 0,
      }) });
    const persisted = await lifecycle.resolveAndPersist('movie', movie.id, movie,
      async () => adaptV2ToLegacyResult(primary.selected));
    assert.equal(persisted.stream_type, 'mp4');
    assert.equal(persisted.stream_url, primary.selected.url);
    assert.equal(persisted.status, 'ready');
    const { rows: stored } = await db.query('SELECT * FROM streams WHERE id = $1',
      [persisted.id]);
    assert.equal(stored[0].stream_url, primary.selected.url);
    assert.equal(stored[0].provider, 'internet_archive');

    await db.query(`UPDATE streams SET last_verified_at = NOW() - INTERVAL '1 hour'
      WHERE id = $1`, [persisted.id]);
    const revalidated = await lifecycle.readUsableCache('movie', movie.id,
      { validate: true });
    assert.equal(revalidated.streams[0].status, 'ready');
    assert.equal(revalidated.streams[0].stream_url, primary.selected.url);

    const service = createStreamsService({ db, findContent: async () => movie,
      subtitleFetcher: async () => null, subscriptionFetcher: async () => null,
      queue: { enqueue: async () => { throw new Error('unexpected enqueue'); } },
      metrics: { increment: async () => {} },
      stats: { recordRequest: async () => {} },
      logger: { log() {}, warn() {} }, cacheTtlMinutes: 60,
      verifyIntervalMinutes: 10, prewarmNextEpisode: false });
    const api = await service.getMovieStreams(movie.id, null);
    assert.equal(api.status, 'ready');
    assert.equal(api.stream.type, 'mp4');
    assert.equal(api.stream.url, primary.selected.url);
    assert.equal(api.streams[0].stream_type, 'mp4');
    assert.equal(/"(?:license|licenseUrl|rights)"/i.test(JSON.stringify(api)), false);
    assert.equal(requests.some((request) => request.path.includes('search') ||
      request.path.includes('catalog')), false);
    assert.deepEqual(requests.filter((request) => request.method === 'GET' &&
      request.path === '/cdn/film').map((request) => request.range),
    ['bytes=0-63', 'bytes=0-63']);

    // Opt-in manual validation only: npm test remains fully offline.
    if (process.env.ARCHIVE_REAL_E2E !== '1') return;
    await mappingStore.markInactive({ providerId: 'internet_archive', region: 'global',
      contentType: 'movie', externalId: fixtureId });
    await mappingStore.upsertMapping({ providerId: 'internet_archive', region: 'global',
      contentType: 'movie', tmdbId: 10378, externalId: 'BigBuckBunny_328',
      matchMethod: 'manual', status: 'active' });

    const outbound = [];
    const safe = createSafeHttpClient({ timeoutMs: 15000 });
    const realHttp = {
      get: (url, options) => {
        outbound.push({ method: 'GET', maxBytes: options?.maxBytes,
          range: options?.headers?.range || null });
        return safe.get(url, options);
      },
      head: (url, options) => {
        outbound.push({ method: 'HEAD' });
        return safe.head(url, options);
      },
    };
    const realCatalog = { version: 1, sources: [{ id: 'internet_archive',
      type: 'internet_archive', enabled: true, region: 'global',
      baseUrl: 'https://archive.org', timeoutMs: 10000,
      supportsEpisodes: false, maxCandidates: 1 }], resolvers: [] };
    const realPipeline = createShadowPipeline({ catalogEnabled: true,
      catalogPath: 'real-diagnostic.json',
      catalogReadFile: () => JSON.stringify(realCatalog),
      providerMappingResolver: mappingResolver, httpClient: realHttp,
      primaryEnabled: true, primaryTimeoutMs: 15000, healthEnabled: false });
    const realPrimary = await realPipeline.primaryResolver.resolve(context);
    const canonical = 'https://archive.org/download/BigBuckBunny_328/BigBuckBunny_512kb.mp4';
    assert.equal(realPrimary.status, 'accepted');
    assert.equal(realPrimary.selected.validated, true);
    assert.equal(realPrimary.selected.url, canonical);
    assert.equal(realPrimary.selected.metadata.itemId, 'BigBuckBunny_328');
    assert.equal(realPrimary.selected.metadata.filename, 'BigBuckBunny_512kb.mp4');
    assert.equal(Object.hasOwn(realPrimary.selected.metadata, 'licenseUrl'), false);

    const realRevalidator = createDirectMp4Resolver({ httpClient: realHttp,
      timeoutMs: 15000 });
    const realLifecycle = createStreamLifecycle({ db,
      validator: async () => ({ valid: false }), logger: { log() {}, warn() {} },
      cacheTtlMinutes: 60, verifyIntervalMinutes: 10,
      mp4Validator: async (url, { headers }) => ({
        valid: (await realRevalidator.resolve({ providerId: 'cached_mp4', url, headers }))
          .length > 0,
      }) });
    const realPersisted = await realLifecycle.resolveAndPersist('movie', movie.id, movie,
      async () => adaptV2ToLegacyResult(realPrimary.selected));
    assert.equal(realPersisted.stream_url, canonical);
    assert.equal(realPersisted.stream_type, 'mp4');
    const { rows: reloaded } = await db.query(
      'SELECT stream_url, provider, stream_type FROM streams WHERE id = $1',
      [realPersisted.id]);
    assert.deepEqual(reloaded[0], { stream_url: canonical,
      provider: 'internet_archive', stream_type: 'mp4' });
    await db.query(`UPDATE streams SET last_verified_at = NOW() - INTERVAL '1 hour'
      WHERE id = $1`, [realPersisted.id]);
    const realCache = await realLifecycle.readUsableCache('movie', movie.id,
      { validate: true });
    assert.equal(realCache.streams[0].stream_url, canonical);
    const realApi = await service.getMovieStreams(movie.id, null);
    assert.equal(realApi.status, 'ready');
    assert.equal(realApi.stream.url, canonical);
    assert.equal(realApi.stream.type, 'mp4');
    assert.equal(/"(?:license|licenseUrl|rights)"/i.test(JSON.stringify(realApi)), false);
    assert.deepEqual(outbound.map(({ method }) => method),
      ['GET', 'HEAD', 'GET', 'HEAD', 'GET']);
    assert.deepEqual(outbound.filter(({ method }) => method === 'GET')
      .map(({ maxBytes, range }) => [maxBytes, range]),
    [[512 * 1024, null], [64, 'bytes=0-63'], [64, 'bytes=0-63']]);
    t.diagnostic('Archive real: Primary accepted; canonical MP4 persisted and revalidated; ' +
      'five bounded client operations; no full video download');
  });
