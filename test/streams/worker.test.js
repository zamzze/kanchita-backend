'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://worker:worker@127.0.0.1:5432/worker';
process.env.JWT_SECRET ||= 'worker-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'worker-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'worker-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_worker_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;
const { runMigrations } = require('../../database/migrate');
const { createHlsValidator } = require('../../src/modules/streams/hlsValidator');
const { createResolutionQueue } = require('../../src/modules/streams/resolutionQueue');
const { createStreamProcessor } = require('../../src/modules/streams/streamProcessor');
const { createStreamWorker } = require('../../src/workers/streamResolutionWorker');
const configuredPool = require('../../src/config/db');

let server;
let baseUrl;
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n';

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/valid')) return res.end(manifest);
    if (req.url.startsWith('/invalid')) return res.end('<html>invalid</html>');
    res.writeHead(404);
    return res.end();
  });
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

const messagesLogger = () => {
  const messages = [];
  return {
    messages,
    log: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
};

test(
  'stream worker resolves persistent jobs outside the HTTP process',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run worker integration tests' },
  async (t) => {
    let tmdbId = 20_000;
    const reset = () => pool.query(
      'TRUNCATE stream_resolution_jobs, streams, episodes, series, movies CASCADE'
    );
    const createContent = async (contentType) => {
      tmdbId += 1;
      if (contentType === 'movie') {
        return (await pool.query(
          `INSERT INTO movies (tmdb_id, title, is_published)
           VALUES ($1, $2, TRUE) RETURNING *`,
          [tmdbId, `Worker movie ${tmdbId}`]
        )).rows[0];
      }
      const series = (await pool.query(
        `INSERT INTO series (tmdb_id, title, is_published)
         VALUES ($1, $2, TRUE) RETURNING *`,
        [tmdbId, `Worker series ${tmdbId}`]
      )).rows[0];
      const episode = (await pool.query(
        `INSERT INTO episodes
           (series_id, season_number, episode_number, title, is_published)
         VALUES ($1, 1, 1, 'Pilot', TRUE) RETURNING *`,
        [series.id]
      )).rows[0];
      return { ...episode, tmdb_id: series.tmdb_id };
    };
    const makeWorker = ({
      queue = createResolutionQueue(pool),
      resolver,
      validator,
      logger = messagesLogger(),
      workerId = `worker-${crypto.randomUUID()}`,
      resolutionTimeoutMs = 500,
    } = {}) => {
      let resolverCalls = 0;
      let validatorCalls = 0;
      const resolverExecutor = {
        resolve: async (context) => {
          resolverCalls += 1;
          return resolver
            ? resolver(context)
            : { url: `${baseUrl}/valid?token=worker-secret`, provider: 'fixture' };
        },
        shutdown: async () => {},
      };
      const processor = createStreamProcessor({
        db: pool,
        resolverExecutor,
        validator: validator || (async (url) => {
          validatorCalls += 1;
          return createHlsValidator({ allowPrivateNetworks: true })(url);
        }),
        logger,
        cacheTtlMinutes: 60,
        verifyIntervalMinutes: 10,
      });
      const worker = createStreamWorker({
        queue,
        processor,
        logger,
        workerId,
        leaseSeconds: 60,
        resolutionTimeoutMs,
      });
      return {
        worker,
        logger,
        resolverCalls: () => resolverCalls,
        validatorCalls: () => validatorCalls,
      };
    };

    await t.test('claims, resolves, validates and completes movie and episode jobs', async () => {
      await reset();
      for (const contentType of ['movie', 'episode']) {
        const content = await createContent(contentType);
        const queue = createResolutionQueue(pool);
        const job = await queue.enqueue(contentType, content.id);
        const setup = makeWorker({ queue });
        assert.equal(await setup.worker.runOnce(), true);
        assert.equal(setup.resolverCalls(), 1);
        assert.equal(setup.validatorCalls(), 1);

        const storedJob = await pool.query(
          'SELECT status, locked_by, completed_at FROM stream_resolution_jobs WHERE id = $1',
          [job.id]
        );
        assert.equal(storedJob.rows[0].status, 'completed');
        assert.equal(storedJob.rows[0].locked_by, null);
        assert.ok(storedJob.rows[0].completed_at);

        const stream = await pool.query(
          `SELECT status, stream_url, failure_count
           FROM streams WHERE content_type = $1 AND content_id = $2`,
          [contentType, content.id]
        );
        assert.equal(stream.rows[0].status, 'ready');
        assert.equal(stream.rows[0].failure_count, 0);
        assert.match(stream.rows[0].stream_url, /\/valid/);
      }
    });

    await t.test('resolver failure retries, then max attempts becomes failed', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool, { maxAttempts: 2 });
      const job = await queue.enqueue('movie', movie.id);
      const setup = makeWorker({ queue, resolver: async () => null });

      await setup.worker.runOnce();
      let stored = await pool.query(
        'SELECT status, attempt_count, run_after FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].attempt_count, 1);
      assert.ok(new Date(stored.rows[0].run_after).getTime() > Date.now());

      await pool.query(
        `UPDATE stream_resolution_jobs SET run_after = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [job.id]
      );
      await setup.worker.runOnce();
      stored = await pool.query(
        'SELECT status, attempt_count, last_error_code FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'failed');
      assert.equal(stored.rows[0].attempt_count, 2);
      assert.equal(stored.rows[0].last_error_code, 'RESOLUTION_FAILED');
      assert.equal(setup.resolverCalls(), 2);
    });

    await t.test('invalid HLS is retried with a stable code', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      const job = await queue.enqueue('movie', movie.id);
      const setup = makeWorker({
        queue,
        resolver: async () => ({ url: `${baseUrl}/invalid?token=hidden`, provider: 'fixture' }),
        validator: createHlsValidator({ allowPrivateNetworks: true }),
      });
      await setup.worker.runOnce();
      const stored = await pool.query(
        'SELECT status, last_error_code FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].last_error_code, 'HLS_INVALID_MANIFEST');
    });

    await t.test('unsafe HLS is rejected without private network access', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      const job = await queue.enqueue('movie', movie.id);
      const setup = makeWorker({
        queue,
        resolver: async () => ({ url: `${baseUrl}/valid?token=blocked`, provider: 'fixture' }),
        validator: createHlsValidator(),
      });
      await setup.worker.runOnce();
      const stored = await pool.query(
        'SELECT last_error_code FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].last_error_code, 'HLS_UNSAFE_DESTINATION');
    });

    await t.test('two workers never process the same active job', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      await queue.enqueue('movie', movie.id);
      let calls = 0;
      const resolver = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        return { url: `${baseUrl}/valid`, provider: 'fixture' };
      };
      const first = makeWorker({ queue, resolver, workerId: 'worker-a' });
      const second = makeWorker({ queue, resolver, workerId: 'worker-b' });
      const results = await Promise.all([first.worker.runOnce(), second.worker.runOnce()]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(calls, 1);
    });

    await t.test('completed jobs are not reprocessed and lease recovery is idempotent', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      const job = await queue.enqueue('movie', movie.id);
      const first = makeWorker({ queue, workerId: 'dead-worker' });
      await first.worker.runOnce();
      assert.equal(await first.worker.runOnce(), false);
      assert.equal(first.resolverCalls(), 1);

      // Simulate a crash after stream persistence but before job completion.
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET status = 'processing', locked_by = 'dead-worker',
             locked_at = NOW() - INTERVAL '10 minutes', completed_at = NULL
         WHERE id = $1`,
        [job.id]
      );
      await queue.recoverStaleJobs(60);
      await pool.query(
        `UPDATE stream_resolution_jobs SET run_after = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [job.id]
      );
      const recovered = makeWorker({ queue, workerId: 'replacement-worker' });
      await recovered.worker.runOnce();
      assert.equal(recovered.resolverCalls(), 0);
      const state = await pool.query(
        'SELECT status FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(state.rows[0].status, 'completed');
    });

    await t.test('contained resolution timeout retries and worker remains usable', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      const job = await queue.enqueue('movie', movie.id);
      const setup = makeWorker({
        queue,
        resolver: async () => {
          const error = new Error('fixture timeout');
          error.code = 'RESOLUTION_TIMEOUT';
          throw error;
        },
        resolutionTimeoutMs: 25,
      });
      await setup.worker.runOnce();
      const stored = await pool.query(
        'SELECT status, locked_by, last_error_code FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].locked_by, null);
      assert.equal(stored.rows[0].last_error_code, 'RESOLUTION_TIMEOUT');
      assert.equal(setup.worker.isStopping(), false);
      const stream = await pool.query(
        `SELECT status, failure_count, last_error_code, next_retry_at
         FROM streams WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      assert.equal(stream.rows[0].status, 'failed');
      assert.equal(stream.rows[0].failure_count, 1);
      assert.equal(stream.rows[0].last_error_code, 'RESOLUTION_TIMEOUT');
      assert.ok(stream.rows[0].next_retry_at);
    });

    await t.test('browser capacity exhaustion retries with stream backoff', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      const job = await queue.enqueue('movie', movie.id);
      const setup = makeWorker({
        queue,
        resolver: async () => {
          throw Object.assign(new Error('fixture capacity'), {
            code: 'BROWSER_CAPACITY_UNAVAILABLE',
          });
        },
      });
      await setup.worker.runOnce();
      const stored = await pool.query(
        `SELECT status, last_error_code, run_after
         FROM stream_resolution_jobs WHERE id = $1`,
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].last_error_code, 'BROWSER_CAPACITY_UNAVAILABLE');
      assert.ok(new Date(stored.rows[0].run_after).getTime() > Date.now());
      const stream = await pool.query(
        `SELECT status, failure_count, last_error_code, next_retry_at
         FROM streams WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      assert.equal(stream.rows[0].status, 'failed');
      assert.equal(stream.rows[0].failure_count, 1);
      assert.equal(stream.rows[0].last_error_code, 'BROWSER_CAPACITY_UNAVAILABLE');
      assert.ok(stream.rows[0].next_retry_at);
    });

    await t.test('worker logs do not expose signed URLs', async () => {
      await reset();
      const movie = await createContent('movie');
      const queue = createResolutionQueue(pool);
      await queue.enqueue('movie', movie.id);
      const logger = messagesLogger();
      const secret = 'worker-url-secret';
      const setup = makeWorker({
        queue,
        logger,
        resolver: async () => ({ url: `${baseUrl}/valid?token=${secret}`, provider: 'fixture' }),
      });
      await setup.worker.runOnce();
      assert.doesNotMatch(logger.messages.join('\n'), new RegExp(secret));
      assert.doesNotMatch(logger.messages.join('\n'), /\.m3u8\?|token=/);
    });
  }
);

test('shutdown waits for the current job and prevents new claims', async () => {
  let releaseProcessor;
  let claims = 0;
  const queue = {
    recoverStaleJobs: async () => [],
    claimNextJob: async () => {
      claims += 1;
      return claims === 1 ? { id: crypto.randomUUID() } : null;
    },
    completeJob: async () => ({}),
    failJob: async () => ({}),
    renewJobLease: async () => true,
  };
  const processor = () => new Promise((resolve) => { releaseProcessor = resolve; });
  const worker = createStreamWorker({
    queue,
    processor,
    logger: messagesLogger(),
    workerId: 'shutdown-worker',
    resolutionTimeoutMs: 1000,
  });

  const running = worker.runOnce();
  while (!releaseProcessor) await new Promise((resolve) => setImmediate(resolve));
  const shutdown = worker.shutdown();
  releaseProcessor();
  await Promise.all([running, shutdown]);

  assert.equal(worker.isStopping(), true);
  assert.equal(await worker.runOnce(), false);
  assert.equal(claims, 1);
});

test('a living worker renews its current job lease until processing completes', async () => {
  let releaseProcessor;
  let renewalCallback;
  let renewed = 0;
  let cleared = 0;
  const job = { id: crypto.randomUUID() };
  const queue = {
    recoverStaleJobs: async () => [],
    claimNextJob: async () => job,
    renewJobLease: async (jobId, workerId) => {
      assert.equal(jobId, job.id);
      assert.equal(workerId, 'lease-worker');
      renewed += 1;
      return true;
    },
    completeJob: async () => ({}),
    failJob: async () => ({}),
  };
  const processor = () => new Promise((resolve) => { releaseProcessor = resolve; });
  const worker = createStreamWorker({
    queue,
    processor,
    logger: messagesLogger(),
    workerId: 'lease-worker',
    leaseSeconds: 60,
    resolutionTimeoutMs: 1000,
    setTimer: (callback) => {
      renewalCallback = callback;
      return { unref() {} };
    },
    clearTimer: () => { cleared += 1; },
  });

  const running = worker.runOnce();
  while (!releaseProcessor || !renewalCallback) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await renewalCallback();
  assert.equal(renewed, 1);
  releaseProcessor();
  await running;
  assert.equal(cleared, 1);
});

test('unsafe lease configuration is rejected before the worker starts', () => {
  assert.throws(
    () => createStreamWorker({
      queue: {},
      processor: async () => {},
      leaseSeconds: 100,
      resolutionTimeoutMs: 90_000,
    }),
    /timeout \+ kill grace by at least 30 seconds/
  );
});
