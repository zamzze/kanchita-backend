'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= process.env.TEST_DB_URL ||
  'postgresql://proxy:proxy@127.0.0.1:5432/proxy';
process.env.JWT_SECRET ||= 'proxy-db-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'proxy-db-refresh-secret';
process.env.TMDB_API_KEY ||= 'proxy-db-tmdb-key';

const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createShadowPipeline } =
  require('../src/modules/streams/resolverV2/createShadowPipeline');
const { createStreamProcessor } = require('../src/modules/streams/streamProcessor');
const { createStreamLifecycle } = require('../src/modules/streams/streamLifecycle');
const { createStreamStore } = require('../src/db/streams.queries');
const { createStreamsService } = require('../src/modules/streams/streams.service');
const { createHlsProxyTokenCodec } = require('../src/modules/streams/hlsProxyToken');
const { createHlsProxy } = require('../src/modules/streams/hlsProxy');
const { createHlsProxyRouter } = require('../src/modules/streams/hlsProxy.routes');

const TEST_DB_URL = process.env.TEST_DB_URL;
const secret = 'phase-t-db-proxy-secret-with-at-least-32-characters';
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});
const schemaName = () => `kanchita_proxy_t_${crypto.randomBytes(6).toString('hex')}`;
const noopCounter = { increment: async () => {} };

test('PostgreSQL playback header lifecycle and full proxy chain', {
  skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run PostgreSQL proxy integration tests',
}, async (t) => {
  const schema = schemaName();
  const admin = new Pool({ connectionString: TEST_DB_URL });
  const db = new Pool({ connectionString: TEST_DB_URL,
    options: `-c search_path=${schema},public` });
  let upstream;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const version = await admin.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 150000);
    const migrated = await runMigrations({ pool: db, logger: { log() {} } });
    assert.equal(migrated.applied.at(-1), '007_safe_playback_headers.sql');

    const movie = await db.query(
      `INSERT INTO movies (tmdb_id, title, is_published)
       VALUES (8080, 'Proxy fixture', TRUE) RETURNING id`
    );
    const movieId = movie.rows[0].id;
    const calls = [];
    upstream = http.createServer((req, res) => {
      calls.push({ path: req.url, referer: req.headers.referer, origin: req.headers.origin,
        cookie: req.headers.cookie, authorization: req.headers.authorization });
      const port = upstream.address().port;
      if (req.url === '/movie/8080') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'source=private' });
        return res.end(`<iframe src="http://a.example.test:${port}/a">`);
      }
      if (req.url === '/a') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'a=private' });
        return res.end(`<iframe src="http://b.example.test:${port}/b">`);
      }
      if (req.url === '/b') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'b=private' });
        return res.end(`<video src="http://media.example.test:${port}/master.m3u8">`);
      }
      const expectedReferer = `http://b.example.test:${port}/b`;
      const expectedOrigin = `http://b.example.test:${port}`;
      if (req.headers.referer !== expectedReferer || req.headers.origin !== expectedOrigin) {
        res.writeHead(403); return res.end('denied');
      }
      res.setHeader('Set-Cookie', 'media=private');
      if (req.url === '/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8');
      }
      if (req.url === '/variant.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts');
      }
      res.setHeader('Content-Type', 'video/mp2t');
      return res.end('postgres-proxy-segment');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = upstream.address().port;
    const httpClient = createSafeHttpClient({ allowPrivateNetworks: true,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    const catalog = { version: 1, sources: [{ id: 'html_source', type: 'configured_html',
      enabled: true, baseUrl: `http://source.example.test:${port}`,
      allowedCandidateDomains: ['a.example.test'] }], resolvers: [{ id: 'resolver_a',
      type: 'configured_html', enabled: true, domains: ['a.example.test'],
      allowedMediaDomains: ['media.example.test'], allowedNestedDomains: ['b.example.test'] },
    { id: 'resolver_b', type: 'configured_html', enabled: true, domains: ['b.example.test'],
      allowedMediaDomains: ['media.example.test'], playbackHeaderPolicy: 'referer_origin' }] };
    const runtime = createShadowPipeline({ enabled: false, primaryEnabled: true,
      playbackTransportAvailable: true, healthEnabled: false, catalogEnabled: true,
      catalogPath: 'catalog.json', catalogReadFile: () => JSON.stringify(catalog), httpClient });
    const lifecycle = createStreamLifecycle({ db,
      validator: async () => { throw new Error('validated V2 stream must not be fetched twice'); },
      logger: { log() {}, warn() {} }, cacheTtlMinutes: 60, verifyIntervalMinutes: 10,
      playbackTransportAvailable: true });
    let legacyCalls = 0;
    const processor = createStreamProcessor({ db, lifecycle,
      resolverExecutor: { shutdown: async () => {} },
      validator: async () => ({ valid: true }),
      findContent: async () => ({ tmdb_id: 8080, title: 'Proxy fixture' }),
      providerManager: { resolve: async () => {
        legacyCalls += 1;
        return { url: 'https://legacy.example.test/master.m3u8', provider: 'legacy' };
      } },
      primaryEnabled: true, primaryRolloutPercent: 100, primaryGuardEnabled: false,
      primaryResolver: runtime.primaryResolver, primaryStats: runtime.primaryStats,
      primaryMetrics: noopCounter, stats: { recordReady: async () => {} },
      logger: { log() {}, warn() {} } });
    const persisted = await processor({ content_type: 'movie', content_id: movieId,
      job_type: 'resolve' });
    assert.equal(legacyCalls, 0);
    assert.equal(calls.filter(({ path }) => path === '/movie/8080').length, 1);
    const raw = await db.query(
      'SELECT stream_url, playback_headers, pg_typeof(playback_headers)::text AS header_type FROM streams WHERE id = $1',
      [persisted.id]
    );
    assert.equal(raw.rows[0].header_type, 'jsonb');
    assert.deepEqual(raw.rows[0].playback_headers, persisted.playback_headers);
    const cached = await lifecycle.readUsableCache('movie', movieId, { validate: true });
    assert.equal(cached.streams[0].id, persisted.id);
    assert.deepEqual(cached.streams[0].playback_headers, persisted.playback_headers);

    let tokenNow = Date.now();
    const codec = createHlsProxyTokenCodec({ secret, ttlSeconds: 5, now: () => tokenNow });
    const proxy = createHlsProxy({ enabled: true, tokenCodec: codec,
      store: createStreamStore(db), httpClient });
    const service = createStreamsService({ db, proxy,
      findContent: async () => ({ tmdb_id: 8080, title: 'Proxy fixture' }),
      subtitleFetcher: async () => null, subscriptionFetcher: async () => null,
      metrics: noopCounter, stats: { recordRequest: async () => {} },
      queue: { enqueue: async () => { throw new Error('cache must remain ready'); } },
      logger: { log() {}, warn() {} }, cacheTtlMinutes: 60, verifyIntervalMinutes: 10,
      refreshAheadMinutes: 0, prewarmNextEpisode: false });
    const apiResult = await service.getMovieStreams(movieId, null);
    assert.equal(apiResult.status, 'ready');
    assert.doesNotMatch(JSON.stringify(apiResult),
      /source\.example|a\.example|b\.example|media\.example|referer|origin|\.m3u8/i);

    const app = express();
    app.use('/stream-proxy', createHlsProxyRouter(proxy));
    app.use((error, _req, res, _next) =>
      res.status(error.statusCode || 500).json({ code: error.code }));
    const master = await request(app).get(apiResult.stream.url);
    assert.equal(master.status, 200);
    assert.equal(master.headers['set-cookie'], undefined);
    const variantPath = master.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
    const variant = await request(app).get(variantPath);
    assert.equal(variant.status, 200);
    const segmentPath = variant.text.split('\n').find((line) => line.startsWith('/stream-proxy/'));
    const segment = await request(app).get(segmentPath)
      .set('Cookie', 'client=private').set('Authorization', 'Bearer private');
    assert.equal(segment.status, 200);
    assert.equal(segment.body.toString(), 'postgres-proxy-segment');
    assert.equal(segment.headers['set-cookie'], undefined);

    tokenNow += 6_000;
    const expired = await request(app).get(apiResult.stream.url);
    assert.equal(expired.status, 404);
    const refreshedApiResult = await service.getMovieStreams(movieId, null);
    assert.notEqual(refreshedApiResult.stream.url, apiResult.stream.url);
    assert.equal(codec.verify(refreshedApiResult.stream.url.split('/').at(-1)).streamId,
      persisted.id);
    assert.equal(calls.filter(({ path }) => path === '/movie/8080').length, 1);
    assert.equal(legacyCalls, 0);

    const mediaCalls = calls.filter(({ path }) =>
      ['/master.m3u8', '/variant.m3u8', '/segment.ts'].includes(path));
    assert.equal(mediaCalls.length, 4);
    for (const call of mediaCalls) {
      assert.equal(call.referer, `http://b.example.test:${port}/b`);
      assert.equal(call.origin, `http://b.example.test:${port}`);
      assert.equal(call.cookie, undefined);
      assert.equal(call.authorization, undefined);
    }

    const store = createStreamStore(db);
    const baseWrite = { content_type: 'movie', content_id: crypto.randomUUID(),
      server_name: 'invalid', quality: 'auto', language: 'es', stream_url: 'https://media.example/a.m3u8',
      stream_type: 'direct', priority: 1, status: 'ready' };
    for (const headers of [{ cookie: 'x' }, { authorization: 'x' }, { 'user-agent': 'x' },
      { referer: 'https://example.test/\r\nX-Evil: yes' },
      { origin: 'https://example.test/path' }]) {
      await assert.rejects(store.upsertStream({ ...baseWrite,
        content_id: crypto.randomUUID(), playback_headers: headers }),
      (error) => error.code === 'STREAM_PLAYBACK_HEADERS_INVALID');
    }
    await assert.rejects(db.query(
      `INSERT INTO streams (content_type, content_id, playback_headers)
       VALUES ('movie', $1, '{"cookie":"private"}'::jsonb)`, [crypto.randomUUID()]),
    (error) => error.code === '23514');

    await db.query(`UPDATE streams SET playback_headers =
      '{"origin":"https://example.test/path"}'::jsonb WHERE id = $1`, [persisted.id]);
    const invalidCache = await lifecycle.readUsableCache('movie', movieId, { validate: true });
    assert.equal(invalidCache.streams, null);
    const invalidProxy = proxy.createPlaybackUrl((await db.query(
      'SELECT * FROM streams WHERE id = $1', [persisted.id])).rows[0]);
    assert.equal(invalidProxy, null);
  } finally {
    if (upstream) await close(upstream);
    await db.end();
    const configuredPool = require('../src/config/db');
    await configuredPool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
});
