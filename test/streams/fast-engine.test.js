'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://fast:fast@127.0.0.1:5432/fast';
process.env.JWT_SECRET ||= 'fast-engine-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'fast-engine-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'fast-engine-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_fast_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;
const { runMigrations } = require('../../database/migrate');
const { createBrowserSlotManager } = require('../../src/modules/streams/browserSlots');
const { createHealthService } = require('../../src/modules/health/health.service');
const { createProviderHealthStore } = require('../../src/modules/streams/providerHealth');
const { createResolutionQueue } = require('../../src/modules/streams/resolutionQueue');
const { createStreamLifecycle } = require('../../src/modules/streams/streamLifecycle');
const { createStreamPrewarm } = require('../../src/modules/streams/streamPrewarm');
const { createStreamsService } = require('../../src/modules/streams/streams.service');
const { createWorkerHeartbeatStore } = require('../../src/modules/streams/workerHeartbeat');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/utils/jwt');
const configuredPool = require('../../src/config/db');

const silentLogger = { log() {}, warn() {} };

test('health routes separate public probes from authenticated stream internals', async () => {
  const healthService = {
    live: async () => ({ status: 'live' }),
    ready: async () => ({ status: 'ready' }),
    streamHealth: async () => ({
      queue: { pending: 1, processing: 0 },
      browser: { used: 0, limit: 1 },
      workers: { active: 1 },
      providers: [],
      metrics: {},
    }),
  };
  const app = createApp({
    healthService,
    corsOrigins: [],
    apiLimiter: (req, res, next) => next(),
  });
  assert.equal((await request(app).get('/health/live')).status, 200);
  assert.equal((await request(app).get('/health/ready')).status, 200);
  assert.equal((await request(app).get('/api/internal/stream-health')).status, 401);
  const token = signAccessToken({
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    plan_type: 'free',
  });
  const internal = await request(app)
    .get('/api/internal/stream-health')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(internal.status, 200);
  assert.deepEqual(internal.body.data.browser, { used: 0, limit: 1 });
});

before(async () => {
  if (!TEST_DB_URL) return;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({ pool, logger: silentLogger });
});

after(async () => {
  await pool?.end();
  await configuredPool.end().catch(() => {});
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test(
  'fast stream engine coordinates prepare, refresh and browser capacity in PostgreSQL',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run fast stream integration tests' },
  async (t) => {
    const queue = createResolutionQueue(pool);
    const reset = () => pool.query(`
      TRUNCATE stream_resolution_jobs, stream_browser_slots,
        stream_worker_heartbeats, stream_provider_health, stream_metrics,
        stream_content_stats, streams, episodes, series, movies CASCADE
    `);

    await t.test('priority claim and twenty-user dedup preserve one active job', async () => {
      await reset();
      const lowId = crypto.randomUUID();
      const highId = crypto.randomUUID();
      await queue.enqueue('movie', lowId, { priority: 50 });
      await queue.enqueue('movie', highId, { priority: 100 });
      const first = await queue.claimNextJob('priority-worker');
      assert.equal(first.content_id, highId);
      assert.equal(first.priority, 100);
      await queue.completeJob(first.id, 'priority-worker');

      const sharedId = crypto.randomUUID();
      const jobs = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        queue.enqueue('movie', sharedId, {
          priority: index === 19 ? 100 : 50,
          jobType: index === 19 ? 'refresh' : 'resolve',
        })
      ));
      assert.equal(new Set(jobs.map(({ id }) => id)).size, 1);
      const active = await queue.findActiveJob('movie', sharedId);
      assert.equal(active.priority, 100);
      assert.equal(active.job_type, 'refresh');
    });

    await t.test('global browser budget serializes workers and releases after errors', async () => {
      await reset();
      const slots = createBrowserSlotManager(pool, {
        maxConcurrent: 1,
        leaseSeconds: 2,
        pollMs: 5,
        waitTimeoutMs: 2000,
      });
      let active = 0;
      let maximum = 0;
      let releaseFirst;
      const gate = new Promise((resolve) => { releaseFirst = resolve; });
      const enter = async (wait) => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (wait) await gate;
        active -= 1;
      };
      const first = slots.withSlot('worker-a', () => enter(true));
      while (active === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const second = slots.withSlot('worker-b', () => enter(false));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(maximum, 1);
      releaseFirst();
      await Promise.all([first, second]);
      assert.equal(maximum, 1);

      await assert.rejects(
        slots.withSlot('worker-error', async () => { throw new Error('fixture'); }),
        /fixture/
      );
      const released = await pool.query(
        'SELECT COUNT(*)::integer AS count FROM stream_browser_slots WHERE owner IS NOT NULL'
      );
      assert.equal(released.rows[0].count, 0);
    });

    await t.test('expired browser lease recovers ownership after a crashed worker', async () => {
      await reset();
      const slots = createBrowserSlotManager(pool, {
        maxConcurrent: 1,
        leaseSeconds: 10,
        pollMs: 5,
        waitTimeoutMs: 500,
      });
      const dead = await slots.acquire('dead-worker');
      await pool.query(
        `UPDATE stream_browser_slots SET lease_expires_at = NOW() - INTERVAL '1 second'
         WHERE slot_number = $1`,
        [dead.slot_number]
      );
      const recovered = await slots.acquire('recovery-worker');
      assert.equal(recovered.slot_number, dead.slot_number);
      assert.equal(recovered.owner, 'recovery-worker');
      await slots.release(recovered.slot_number, 'recovery-worker');
    });

    await t.test('prepare is idempotent, prioritized, fast and respects ready/missing/backoff', async () => {
      await reset();
      const movie = (await pool.query(
        `INSERT INTO movies (tmdb_id, title, is_published)
         VALUES (930001, 'Prepare fixture', TRUE) RETURNING id`
      )).rows[0];
      const service = createStreamsService({
        db: pool,
        queue,
        validator: async () => { throw new Error('prepare must not validate'); },
        subtitleFetcher: async () => null,
        subscriptionFetcher: async () => null,
        logger: silentLogger,
      });
      const startedAt = Date.now();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.prepareMovie(movie.id))
      );
      assert.ok(results.every(({ code }) => code === 'STREAM_PREPARING'));
      assert.ok(Date.now() - startedAt < 1000);
      const jobs = await pool.query(
        `SELECT id, priority FROM stream_resolution_jobs
         WHERE content_id = $1 AND status IN ('pending', 'processing')`,
        [movie.id]
      );
      assert.equal(jobs.rowCount, 1);
      assert.equal(jobs.rows[0].priority, 100);

      await pool.query('DELETE FROM stream_resolution_jobs');
      await pool.query(
        `INSERT INTO streams (
           content_type, content_id, server_name, stream_url, stream_type,
           status, expires_at, last_verified_at, is_active
         ) VALUES ('movie', $1, 'HD', 'https://media.example/ready.m3u8',
           'direct', 'ready', NOW() + INTERVAL '1 hour', NOW(), TRUE)`,
        [movie.id]
      );
      assert.equal((await service.prepareMovie(movie.id)).code, 'STREAM_ALREADY_READY');
      assert.equal((await pool.query('SELECT id FROM stream_resolution_jobs')).rowCount, 0);

      await assert.rejects(service.prepareMovie(crypto.randomUUID()), (error) =>
        error.statusCode === 404);
      await pool.query(
        `UPDATE streams SET status = 'failed', expires_at = NULL,
           next_retry_at = NOW() + INTERVAL '10 minutes' WHERE content_id = $1`,
        [movie.id]
      );
      await assert.rejects(service.prepareMovie(movie.id), (error) =>
        error.statusCode === 503 && error.code === 'STREAM_TEMPORARILY_UNAVAILABLE');
    });

    await t.test('next episode prewarm is bounded to one published successor', async () => {
      await reset();
      const series = (await pool.query(
        `INSERT INTO series (tmdb_id, title, is_published)
         VALUES (930002, 'Next fixture', TRUE) RETURNING id`
      )).rows[0];
      const episodes = (await pool.query(
        `INSERT INTO episodes
           (series_id, season_number, episode_number, title, is_published)
         VALUES ($1, 1, 1, 'One', TRUE), ($1, 1, 2, 'Two', TRUE),
                ($1, 1, 3, 'Three', TRUE)
         RETURNING id, episode_number`,
        [series.id]
      )).rows;
      const lifecycle = { readUsableCache: async () => ({ streams: null, backoff: false }) };
      const prewarm = createStreamPrewarm({ db: pool, queue, lifecycle, batchSize: 10 });
      const current = episodes.find(({ episode_number }) => episode_number === 1);
      const next = episodes.find(({ episode_number }) => episode_number === 2);
      await prewarm.prepareNextEpisode(current.id);
      const jobs = await pool.query(
        `SELECT content_id, priority FROM stream_resolution_jobs
         WHERE status IN ('pending', 'processing')`
      );
      assert.equal(jobs.rowCount, 1);
      assert.equal(jobs.rows[0].content_id, next.id);
      assert.equal(jobs.rows[0].priority, 90);
    });

    await t.test('refresh-ahead serves current stream and refresh failure preserves it', async () => {
      await reset();
      const movie = (await pool.query(
        `INSERT INTO movies (tmdb_id, title, is_published)
         VALUES (930003, 'Refresh fixture', TRUE) RETURNING *`
      )).rows[0];
      const stream = (await pool.query(
        `INSERT INTO streams (
           content_type, content_id, server_name, stream_url, stream_type,
           status, expires_at, last_verified_at, is_active, cleanliness
         ) VALUES ('movie', $1, 'HD', 'https://media.example/signed.m3u8?token=secret',
           'direct', 'ready', NOW() + INTERVAL '5 minutes', NOW(), TRUE, 'clean')
         RETURNING *`,
        [movie.id]
      )).rows[0];
      const service = createStreamsService({
        db: pool,
        queue,
        validator: async () => { throw new Error('fresh stream must not revalidate'); },
        subtitleFetcher: async () => null,
        subscriptionFetcher: async () => null,
        logger: silentLogger,
        refreshAheadMinutes: 10,
      });
      const response = await service.getMovieStreams(movie.id, crypto.randomUUID());
      assert.equal(response.streams[0].stream_url, stream.stream_url);
      const refreshJob = await queue.findActiveJob('movie', movie.id);
      assert.equal(refreshJob.job_type, 'refresh');
      assert.equal(refreshJob.priority, 50);

      const lifecycle = createStreamLifecycle({
        db: pool,
        validator: async () => ({ valid: true }),
        logger: silentLogger,
        cacheTtlMinutes: 60,
        verifyIntervalMinutes: 10,
      });
      await assert.rejects(
        lifecycle.resolveAndPersist(
          'movie', movie.id, movie,
          async () => { throw Object.assign(new Error('secret URL'), { code: 'RESOLUTION_FAILED' }); },
          { preserveCurrent: true }
        ),
        (error) => error.code === 'RESOLUTION_FAILED'
      );
      const preserved = await pool.query(
        'SELECT status, stream_url, failure_count FROM streams WHERE id = $1',
        [stream.id]
      );
      assert.equal(preserved.rows[0].status, 'ready');
      assert.equal(preserved.rows[0].stream_url, stream.stream_url);
      assert.equal(preserved.rows[0].failure_count, 1);
    });

    await t.test('provider circuit, heartbeat and aggregate health remain URL-free', async () => {
      await reset();
      const health = createProviderHealthStore(pool, {
        failureThreshold: 2,
        cooldownSeconds: 60,
      });
      await health.recordFailure('fixture_provider', 20);
      assert.equal(await health.isAvailable('fixture_provider'), true);
      await health.recordFailure('fixture_provider', 30);
      assert.equal(await health.isAvailable('fixture_provider'), false);
      await health.recordSuccess('fixture_provider', 10);
      assert.equal(await health.isAvailable('fixture_provider'), true);

      const heartbeat = createWorkerHeartbeatStore(pool);
      await heartbeat.start('safe-worker-id');
      await heartbeat.beat('safe-worker-id', null);
      const report = await createHealthService({
        db: pool,
        browserLimit: 1,
        heartbeatSeconds: 30,
      }).streamHealth();
      assert.equal(report.workers.active, 1);
      assert.equal(report.browser.limit, 1);
      assert.equal(report.providers[0].provider_id, 'fixture_provider');
      assert.doesNotMatch(JSON.stringify(report), /\.m3u8|token=|pid/i);
      await heartbeat.stop('safe-worker-id');
    });
  }
);
