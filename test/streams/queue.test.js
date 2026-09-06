'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://queue:queue@127.0.0.1:5432/queue';
process.env.JWT_SECRET ||= 'queue-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'queue-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'queue-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_queue_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;
const { runMigrations } = require('../../database/migrate');
const { createResolutionQueue } = require('../../src/modules/streams/resolutionQueue');
const configuredPool = require('../../src/config/db');

before(async () => {
  if (!TEST_DB_URL) return;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({ pool, logger: { log() {} } });
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
  'persistent stream resolution queue coordinates PostgreSQL workers',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run queue integration tests' },
  async (t) => {
    const queue = createResolutionQueue(pool, { maxAttempts: 3 });
    const reset = () => pool.query('DELETE FROM stream_resolution_jobs');
    const contentId = () => crypto.randomUUID();

    await t.test('enqueue creates pending jobs for movies and episodes', async () => {
      await reset();
      const movie = await queue.enqueue('movie', contentId());
      const episode = await queue.enqueue('episode', contentId());
      assert.equal(movie.status, 'pending');
      assert.equal(episode.status, 'pending');
      assert.equal(movie.attempt_count, 0);
      assert.equal(movie.max_attempts, 3);
    });

    await t.test('duplicate and 20 concurrent enqueues reuse one active job', async () => {
      await reset();
      const id = contentId();
      const first = await queue.enqueue('movie', id);
      const second = await queue.enqueue('movie', id);
      assert.equal(second.id, first.id);

      const concurrent = await Promise.all(
        Array.from({ length: 20 }, () => queue.enqueue('movie', id))
      );
      assert.ok(concurrent.every((job) => job.id === first.id));
      const stored = await pool.query(
        `SELECT id FROM stream_resolution_jobs
         WHERE content_type = 'movie' AND content_id = $1
           AND status IN ('pending', 'processing')`,
        [id]
      );
      assert.equal(stored.rowCount, 1);
    });

    await t.test('claim atomically assigns processing ownership', async () => {
      await reset();
      const id = contentId();
      await queue.enqueue('movie', id);
      const [first, second] = await Promise.all([
        queue.claimNextJob('worker-a'),
        queue.claimNextJob('worker-b'),
      ]);
      const claimed = [first, second].filter(Boolean);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].status, 'processing');
      assert.equal(claimed[0].attempt_count, 1);
      assert.ok(claimed[0].locked_at);
      assert.ok(['worker-a', 'worker-b'].includes(claimed[0].locked_by));
    });

    await t.test('different jobs can be claimed by different workers', async () => {
      await reset();
      await queue.enqueue('movie', contentId());
      await queue.enqueue('episode', contentId());
      const [first, second] = await Promise.all([
        queue.claimNextJob('worker-a'),
        queue.claimNextJob('worker-b'),
      ]);
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.id, second.id);
    });

    await t.test('future run_after is not claimable', async () => {
      await reset();
      const job = await queue.enqueue('movie', contentId());
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET run_after = NOW() + INTERVAL '10 minutes' WHERE id = $1`,
        [job.id]
      );
      assert.equal(await queue.claimNextJob('worker-a'), null);
    });

    await t.test('only a claim increments attempts and attempts never exceed max', async () => {
      await reset();
      const id = contentId();
      const job = await queue.enqueue('movie', id);
      await queue.enqueue('movie', id);
      await queue.findActiveJob('movie', id);
      await queue.recoverStaleJobs(60);

      let stored = await pool.query(
        'SELECT attempt_count FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].attempt_count, 0);

      await queue.claimNextJob('worker-a');
      await queue.failJob(job.id, 'worker-a', 'RESOLUTION_FAILED');
      stored = await pool.query(
        'SELECT attempt_count, max_attempts FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      );
      assert.equal(stored.rows[0].attempt_count, 1);
      assert.ok(stored.rows[0].attempt_count <= stored.rows[0].max_attempts);
    });

    await t.test('completed and failed jobs stop being active and allow a new job', async () => {
      await reset();
      const id = contentId();
      const completed = await queue.enqueue('movie', id);
      await queue.claimNextJob('worker-a');
      const result = await queue.completeJob(completed.id, 'worker-a');
      assert.equal(result.status, 'completed');
      assert.equal(await queue.findActiveJob('movie', id), null);
      const replacement = await queue.enqueue('movie', id);
      assert.notEqual(replacement.id, completed.id);

      await reset();
      const terminalQueue = createResolutionQueue(pool, { maxAttempts: 1 });
      const failed = await terminalQueue.enqueue('episode', id);
      await terminalQueue.claimNextJob('worker-b');
      const terminal = await terminalQueue.failJob(
        failed.id,
        'worker-b',
        'RESOLUTION_FAILED'
      );
      assert.equal(terminal.status, 'failed');
      assert.equal(await terminalQueue.findActiveJob('episode', id), null);
    });

    await t.test('failure retries with future run_after and safe error codes', async () => {
      await reset();
      const job = await queue.enqueue('movie', contentId());
      await queue.claimNextJob('worker-a');
      const retried = await queue.failJob(job.id, 'worker-a', 'provider said token=secret');
      assert.equal(retried.status, 'pending');
      assert.equal(retried.last_error_code, 'INTERNAL_JOB_ERROR');
      assert.ok(new Date(retried.run_after).getTime() > Date.now());
      assert.equal(await queue.claimNextJob('worker-b'), null);
    });

    await t.test('expired leases recover but live leases are not stolen', async () => {
      await reset();
      const stale = await queue.enqueue('movie', contentId());
      const live = await queue.enqueue('episode', contentId());
      const staleClaim = await queue.claimNextJob('worker-stale');
      const liveClaim = await queue.claimNextJob('worker-live');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET locked_at = NOW() - INTERVAL '10 minutes'
         WHERE id = $1`,
        [staleClaim.id]
      );

      const recovered = await queue.recoverStaleJobs(60);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].id, staleClaim.id);
      assert.equal(recovered[0].status, 'pending');
      assert.equal(recovered[0].locked_by, null);
      assert.equal(recovered[0].last_error_code, 'JOB_LEASE_EXPIRED');
      const stillLive = await pool.query(
        'SELECT status, locked_by FROM stream_resolution_jobs WHERE id = $1',
        [liveClaim.id]
      );
      assert.equal(stillLive.rows[0].status, 'processing');
      assert.equal(stillLive.rows[0].locked_by, 'worker-live');
    });

    await t.test('only the living owner can renew a processing job lease', async () => {
      await reset();
      const job = await queue.enqueue('movie', contentId());
      const claimed = await queue.claimNextJob('living-worker');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET locked_at = NOW() - INTERVAL '30 seconds' WHERE id = $1`,
        [job.id]
      );
      const before = (await pool.query(
        'SELECT locked_at FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      )).rows[0].locked_at;

      assert.equal(await queue.renewJobLease(claimed.id, 'wrong-worker'), false);
      assert.equal(await queue.renewJobLease(claimed.id, 'living-worker'), true);
      const renewed = (await pool.query(
        'SELECT locked_at FROM stream_resolution_jobs WHERE id = $1',
        [job.id]
      )).rows[0].locked_at;
      assert.ok(new Date(renewed).getTime() > new Date(before).getTime());
      assert.deepEqual(await queue.recoverStaleJobs(10), []);

      await queue.completeJob(job.id, 'living-worker');
      assert.equal(await queue.renewJobLease(job.id, 'living-worker'), false);
    });

    await t.test('a dead worker lease is still recovered after renewal stops', async () => {
      await reset();
      const job = await queue.enqueue('episode', contentId());
      await queue.claimNextJob('dead-worker');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [job.id]
      );
      const recovered = await queue.recoverStaleJobs(60);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].id, job.id);
      assert.equal(recovered[0].last_error_code, 'JOB_LEASE_EXPIRED');
    });

    await t.test('concurrent stale recovery is idempotent', async () => {
      await reset();
      const job = await queue.enqueue('movie', contentId());
      await queue.claimNextJob('dead-worker');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [job.id]
      );

      const [first, second] = await Promise.all([
        queue.recoverStaleJobs(60),
        queue.recoverStaleJobs(60),
      ]);
      assert.equal(first.length + second.length, 1);
      const stored = await pool.query(
        `SELECT status, attempt_count, locked_by, last_error_code
         FROM stream_resolution_jobs WHERE id = $1`,
        [job.id]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].attempt_count, 1);
      assert.equal(stored.rows[0].locked_by, null);
      assert.equal(stored.rows[0].last_error_code, 'JOB_LEASE_EXPIRED');
    });

    await t.test('an expired lease at max attempts becomes failed', async () => {
      await reset();
      const terminalQueue = createResolutionQueue(pool, { maxAttempts: 1 });
      const job = await terminalQueue.enqueue('movie', contentId());
      await terminalQueue.claimNextJob('dead-worker');
      await pool.query(
        `UPDATE stream_resolution_jobs
         SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [job.id]
      );
      const [recovered] = await terminalQueue.recoverStaleJobs(60);
      assert.equal(recovered.status, 'failed');
      assert.ok(recovered.completed_at);
    });

    await t.test('job schema cannot store stream URLs or token payloads', async () => {
      const columns = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'stream_resolution_jobs'
      `);
      const names = columns.rows.map((row) => row.column_name);
      assert.ok(!names.some((name) => /url|manifest|token|payload|stack/i.test(name)));

      const data = await pool.query('SELECT row_to_json(j)::text AS value FROM stream_resolution_jobs j');
      assert.ok(data.rows.every(({ value }) => !/token=|\.m3u8/i.test(value)));
    });
  }
);
