'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');
const { Pool } = require('pg');
const express = require('express');
const request = require('supertest');

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
  process.env.DB_URL = TEST_DB_URL;
} else {
  process.env.DB_URL = 'postgresql://persisted:persisted@127.0.0.1:5432/persisted';
}
process.env.JWT_SECRET ||= 'persisted-db-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'persisted-db-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'persisted-db-test-tmdb';

const { runMigrations } = require('../database/migrate');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { createProviderMediaMappingResolver } =
  require('../src/modules/streams/providerMediaMappingResolver');
const { createProviderSourceStore } = require('../src/db/providerSources.queries');
const { createSafeHttpClient } =
  require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createStreamLifecycle } =
  require('../src/modules/streams/streamLifecycle');
const { createStreamProcessor } =
  require('../src/modules/streams/streamProcessor');
const { createStreamsService } = require('../src/modules/streams/streams.service');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { createTrustedPlaybackModeForStream } =
  require('../src/modules/streams/trustedPlaybackTransport');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { createStreamStore } = require('../src/db/streams.queries');
const configuredPool = require('../src/config/db');

test('isolated PostgreSQL exact mapping → persisted source → worker Primary → streams',
  { skip: TEST_DB_URL ? false : 'TEST_DB_URL is required for PostgreSQL integration' },
  async (t) => {
    const schema = `persisted_source_${crypto.randomBytes(5).toString('hex')}`;
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
      await runMigrations({ pool: db, logger: { log() {} } });
      const applied = await db.query('SELECT version FROM schema_migrations');
      assert.ok(applied.rows.some((item) =>
        item.version === '010_bulk_ingestion_persistence.sql'));

      const referer = 'https://ref.example.test/authorized';
      let manifestRequests = 0;
      const server = http.createServer((request, response) => {
        manifestRequests += 1;
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.referer, referer);
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const manifestUrl = `http://127.0.0.1:${server.address().port}/master.m3u8`;

      const { rows: movies } = await db.query(
        "INSERT INTO movies (tmdb_id,title,is_published) VALUES (550,'Fixture',TRUE) RETURNING id");
      const movieId = movies[0].id;
      const mappings = createProviderMediaMappingStore(db);
      const mapping = await mappings.upsertMapping({ providerId: 'fixture_persisted',
        region: 'global', contentType: 'movie', tmdbId: 550,
        externalId: 'stable-item-550', matchMethod: 'manual' });
      const sources = createProviderSourceStore(db);
      const source = await sources.upsertSource({ mappingId: Number(mapping.id),
        sourceType: 'direct_hls', sourceUrl: manifestUrl, headers: { referer } });
      const catalog = { version: 1, sources: [{ id: 'fixture_persisted',
        type: 'persisted_sources', enabled: true, region: 'global' }] };
      const pipeline = createShadowPipeline({ catalogEnabled: true,
        catalogPath: 'fixture.json', catalogReadFile: () => JSON.stringify(catalog),
        providerMappingResolver: createProviderMediaMappingResolver({ store: mappings }),
        providerSourceStore: sources,
        httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
        primaryEnabled: true, playbackTransportAvailable: true, healthEnabled: false });
      const lifecycle = createStreamLifecycle({ db,
        validator: async () => ({ valid: true }),
        logger: { log() {}, warn() {} }, cacheTtlMinutes: 60,
        verifyIntervalMinutes: 10, playbackTransportAvailable: true });
      const processor = createStreamProcessor({ db, primaryEnabled: true,
        primaryRolloutPercent: 100, primaryMoviesEnabled: true,
        primaryGuardEnabled: false, primaryResolver: pipeline.primaryResolver,
        providerManager: { resolve: async () => { throw new Error('legacy must not run'); } },
        resolverExecutor: { shutdown: async () => {} }, lifecycle,
        logger: { log() {}, warn() {} } });
      const resolved = await processor({ content_type: 'movie', content_id: movieId,
        job_type: 'resolve' });
      assert.equal(resolved.status, 'ready');
      assert.equal(resolved.stream_url, manifestUrl);
      assert.equal(resolved.provider, 'fixture_persisted');
      assert.deepEqual(resolved.playback_headers, { referer });
      assert.equal(manifestRequests, 1);
      const reloaded = await db.query(
        'SELECT stream_url,provider,playback_headers FROM streams WHERE id = $1',
        [resolved.id]);
      assert.equal(reloaded.rows[0].stream_url, manifestUrl);
      assert.equal(reloaded.rows[0].provider, 'fixture_persisted');
      assert.deepEqual(reloaded.rows[0].playback_headers, { referer });
      assert.equal((await lifecycle.readUsableCache('movie', movieId)).streams.length, 1);
      assert.equal((await sources.findActiveSourcesForMapping(Number(mapping.id)))[0].id,
        source.id);
      assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM resolved_stream_cache'))
        .rows[0].count, 0);

      const trustedCatalog = loadResolverV2Catalog({ enabled: true,
        filePath: 'fixture.json', readFile: () => JSON.stringify({ version: 1,
          sources: [{ ...catalog.sources[0], hlsProxyMode: 'playlists-only' }] }) });
      const codec = createHlsProxyTokenCodec({
        secret: 'persisted-source-playback-test-secret-32',
      });
      const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
        store: createStreamStore(db),
        httpClient: createSafeHttpClient({ allowPrivateNetworks: true }) });
      const service = createStreamsService({ db, proxy,
        playbackModeForStream: createTrustedPlaybackModeForStream(trustedCatalog),
        validator: async () => ({ valid: true }),
        findContent: async () => ({ tmdb_id: 550 }),
        subtitleFetcher: async () => null,
        stats: { recordRequest: async () => {} },
        metrics: { increment: async () => {} },
        logger: { log() {}, warn() {} } });
      const ready = await service.getMovieStreams(movieId);
      assert.equal(ready.status, 'ready');
      const playbackUrl = ready.stream.url;
      assert.equal(codec.verify(playbackUrl.split('/').at(-1)).mode, 'playlists-only');
      const app = express();
      app.use('/stream-proxy', createHlsProxyRouter(proxy));
      app.use((error, _req, res, _next) =>
        res.status(error.statusCode || 500).json({ code: error.code }));
      const manifest = await request(app).get(playbackUrl);
      assert.equal(manifest.status, 200);
      assert.match(manifest.text, new RegExp(`http://127\\.0\\.0\\.1:${server.address().port}/segment\\.ts`));
      assert.equal(manifestRequests, 2);
  });
