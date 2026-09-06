'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://httpworker:httpworker@127.0.0.1:5432/httpworker';
process.env.JWT_SECRET ||= 'http-worker-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'http-worker-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'http-worker-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_http_worker_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;
const { runMigrations } = require('../../database/migrate');
const { createApp } = require('../../src/app');
const { createHlsValidator } = require('../../src/modules/streams/hlsValidator');
const { createResolutionQueue } = require('../../src/modules/streams/resolutionQueue');
const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
const { createStreamsService } = require('../../src/modules/streams/streams.service');
const { createStreamWorker } = require('../../src/workers/streamResolutionWorker');
const { signAccessToken } = require('../../src/utils/jwt');
const configuredPool = require('../../src/config/db');

let server;
let baseUrl;
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n';

before(async () => {
  server = http.createServer((req, res) => res.end(manifest));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (TEST_DB_URL) {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    await runMigrations({ pool, logger: { log() {} } });
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await pool?.end();
  await configuredPool.end().catch(() => {});
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test(
  'HTTP enqueue to worker to ready is asynchronous and persistent',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run HTTP/worker integration test' },
  async (t) => {
    let heavyResolverCallsFromHttp = 0;
    let workerResolverCalls = 0;
    const movie = (await pool.query(
      `INSERT INTO movies (tmdb_id, title, is_published)
       VALUES (900001, 'Queue E2E movie', TRUE) RETURNING *`
    )).rows[0];
    const queue = createResolutionQueue(pool);
    const streamsService = createStreamsService({
      db: pool,
      queue,
      // Deliberately ignored: the HTTP service has no resolver dependency.
      resolver: async () => {
        heavyResolverCallsFromHttp += 1;
        throw new Error('HTTP must not call the resolver');
      },
      validator: createHlsValidator({ allowPrivateNetworks: true }),
      subtitleFetcher: async () => null,
      subscriptionFetcher: async () => null,
      logger: { log() {}, warn() {} },
      pendingRetrySeconds: 2,
    });
    const app = createApp({
      streamsService,
      corsOrigins: ['https://pwa.example.test'],
      apiLimiter: (req, res, next) => next(),
    });
    const token = signAccessToken({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      plan_type: 'free',
    });
    const getMovie = () => request(app)
      .get(`/api/streams/movie/${movie.id}`)
      .set('Authorization', `Bearer ${token}`);

    await t.test('missing stream returns stable 202 and one reusable job', async () => {
      const first = await getMovie();
      assert.equal(first.status, 202);
      assert.equal(first.headers['retry-after'], '2');
      assert.deepEqual(first.body.data, {
        status: 'pending',
        code: 'STREAM_RESOLUTION_PENDING',
        retry_after_ms: 2000,
      });
      assert.equal(heavyResolverCallsFromHttp, 0);

      const second = await getMovie();
      assert.equal(second.status, 202);
      assert.equal(heavyResolverCallsFromHttp, 0);
      const jobs = await pool.query(
        `SELECT id FROM stream_resolution_jobs
         WHERE content_type = 'movie' AND content_id = $1
           AND status IN ('pending', 'processing')`,
        [movie.id]
      );
      assert.equal(jobs.rowCount, 1);

      await pool.query(
        `UPDATE stream_resolution_jobs
         SET status = 'processing', locked_at = NOW(), locked_by = 'fixture-worker'
         WHERE id = $1`,
        [jobs.rows[0].id]
      );
      const processing = await getMovie();
      assert.equal(processing.status, 202);
      assert.equal(processing.body.data.code, 'STREAM_RESOLUTION_PENDING');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET status = 'pending', locked_at = NULL, locked_by = NULL
         WHERE id = $1`,
        [jobs.rows[0].id]
      );
    });

    await t.test('worker resolves once and the same GET then returns 200', async () => {
      const processor = createStreamProcessor({
        db: pool,
        resolver: async () => {
          workerResolverCalls += 1;
          return { url: `${baseUrl}/movie.m3u8`, provider: 'fixture' };
        },
        validator: createHlsValidator({ allowPrivateNetworks: true }),
        logger: { log() {}, warn() {} },
        cacheTtlMinutes: 60,
        verifyIntervalMinutes: 10,
      });
      const worker = createStreamWorker({
        queue,
        processor,
        logger: { log() {}, warn() {} },
        workerId: 'e2e-worker',
        leaseSeconds: 60,
        resolutionTimeoutMs: 1000,
      });
      assert.equal(await worker.runOnce(), true);
      assert.equal(workerResolverCalls, 1);

      const completedJob = await pool.query(
        `SELECT status, completed_at
         FROM stream_resolution_jobs
         WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      assert.equal(completedJob.rows[0].status, 'completed');
      assert.ok(completedJob.rows[0].completed_at);

      const ready = await getMovie();
      assert.equal(ready.status, 200);
      assert.equal(ready.body.data.content_type, 'movie');
      assert.equal(ready.body.data.content_id, movie.id);
      assert.equal(ready.body.data.streams[0].stream_url, `${baseUrl}/movie.m3u8`);
    });

    await t.test('missing content remains 404 and creates no job', async () => {
      const missingId = crypto.randomUUID();
      const response = await request(app)
        .get(`/api/streams/movie/${missingId}`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 404);
      const jobs = await pool.query(
        'SELECT id FROM stream_resolution_jobs WHERE content_id = $1',
        [missingId]
      );
      assert.equal(jobs.rowCount, 0);
    });

    await t.test('stream lifecycle backoff remains 503 and does not enqueue', async () => {
      const blocked = (await pool.query(
        `INSERT INTO movies (tmdb_id, title, is_published)
         VALUES (900002, 'Backoff movie', TRUE) RETURNING *`
      )).rows[0];
      await pool.query(
        `INSERT INTO streams (
           content_type, content_id, server_name, stream_type, is_active,
           status, failure_count, last_failure_at, next_retry_at, last_error_code
         ) VALUES (
           'movie', $1, 'HD', 'direct', TRUE, 'failed', 1, NOW(),
           NOW() + INTERVAL '10 minutes', 'RESOLUTION_FAILED'
         )`,
        [blocked.id]
      );
      const response = await request(app)
        .get(`/api/streams/movie/${blocked.id}`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'STREAM_TEMPORARILY_UNAVAILABLE');
      const jobs = await pool.query(
        'SELECT id FROM stream_resolution_jobs WHERE content_id = $1',
        [blocked.id]
      );
      assert.equal(jobs.rowCount, 0);
    });

    await t.test('episodes use the same queue and pending contract', async () => {
      const series = (await pool.query(
        `INSERT INTO series (tmdb_id, title, is_published)
         VALUES (900003, 'Queue E2E series', TRUE) RETURNING *`
      )).rows[0];
      const episode = (await pool.query(
        `INSERT INTO episodes
           (series_id, season_number, episode_number, title, is_published)
         VALUES ($1, 1, 1, 'Pilot', TRUE) RETURNING *`,
        [series.id]
      )).rows[0];
      const response = await request(app)
        .get(`/api/streams/episode/${episode.id}`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 202);
      assert.equal(response.body.data.code, 'STREAM_RESOLUTION_PENDING');
      const job = await queue.findActiveJob('episode', episode.id);
      assert.equal(job.content_type, 'episode');
    });
  }
);
