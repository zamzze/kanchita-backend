'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations,
} = require('../../database/migrate');

const TEST_DB_URL = process.env.TEST_DB_URL;
const silentLogger = { log() {} };

const schemaName = (label) =>
  `kanchita_${label}_${crypto.randomBytes(6).toString('hex')}`;

const poolForSchema = (connectionString, schema) =>
  new Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
  });

test('migration files are ordered and checksummed deterministically', async () => {
  const migrations = await loadMigrations();

  assert.deepEqual(
    migrations.map(({ version }) => version),
    [
      '001_legacy_baseline.sql',
      '002_phase_1b_schema_alignment.sql',
      '003_auth_sessions.sql',
      '004_stream_lifecycle.sql',
      '005_stream_resolution_jobs.sql',
    ]
  );
  assert.ok(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));
});

test(
  'PostgreSQL migration integration',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run PostgreSQL integration tests' },
  async (t) => {
    process.env.PORT ||= '3000';
    process.env.DB_URL = TEST_DB_URL;
    process.env.JWT_SECRET ||= 'database-test-access-secret';
    process.env.JWT_REFRESH_SECRET ||= 'database-test-refresh-secret';
    process.env.TMDB_API_KEY ||= 'database-test-tmdb-key';

    const schemas = {
      empty: schemaName('empty'),
      legacy: schemaName('legacy'),
      duplicate: schemaName('duplicate'),
    };
    const adminPool = new Pool({ connectionString: TEST_DB_URL });
    const pools = {};

    try {
      for (const schema of Object.values(schemas)) {
        await adminPool.query(`CREATE SCHEMA "${schema}"`);
      }

      pools.empty = poolForSchema(TEST_DB_URL, schemas.empty);
      pools.legacy = poolForSchema(TEST_DB_URL, schemas.legacy);
      pools.duplicate = poolForSchema(TEST_DB_URL, schemas.duplicate);

      await t.test('applies all migrations to an empty schema only once', async () => {
        const first = await runMigrations({
          pool: pools.empty,
          logger: silentLogger,
        });
        assert.deepEqual(first.applied, [
          '001_legacy_baseline.sql',
          '002_phase_1b_schema_alignment.sql',
          '003_auth_sessions.sql',
          '004_stream_lifecycle.sql',
          '005_stream_resolution_jobs.sql',
        ]);

        const second = await runMigrations({
          pool: pools.empty,
          logger: silentLogger,
        });
        assert.deepEqual(second.applied, []);
        assert.deepEqual(second.skipped, first.applied);

        const { rows } = await pools.empty.query(
          'SELECT version FROM schema_migrations ORDER BY version'
        );
        assert.deepEqual(rows.map((row) => row.version), first.applied);
      });

      await t.test('creates the subtitles contract and enforces uniqueness', async () => {
        const columns = await pools.empty.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'subtitles'
          ORDER BY ordinal_position
        `);
        assert.deepEqual(columns.rows.map((row) => row.column_name), [
          'id',
          'content_type',
          'content_id',
          'subtitle_url',
          'language',
          'is_active',
          'created_at',
          'updated_at',
        ]);

        const contentId = crypto.randomUUID();
        await pools.empty.query(
          `INSERT INTO subtitles
             (content_type, content_id, subtitle_url, language)
           VALUES ('movie', $1, '/subtitles/one.vtt', 'es')`,
          [contentId]
        );

        await assert.rejects(
          pools.empty.query(
            `INSERT INTO subtitles
               (content_type, content_id, subtitle_url, language)
             VALUES ('movie', $1, '/subtitles/two.vtt', 'es')`,
            [contentId]
          ),
          (error) => error.code === '23505'
        );
      });

      await t.test('creates the auth sessions contract and indexes', async () => {
        const columns = await pools.empty.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'auth_sessions'
          ORDER BY ordinal_position
        `);
        assert.deepEqual(columns.rows.map((row) => row.column_name), [
          'id',
          'user_id',
          'refresh_token_hash',
          'expires_at',
          'created_at',
          'last_used_at',
          'revoked_at',
        ]);

        const indexes = await pools.empty.query(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'auth_sessions'
        `);
        const indexNames = indexes.rows.map((row) => row.indexname);
        assert.ok(indexNames.includes('auth_sessions_pkey'));
        assert.ok(indexNames.includes('auth_sessions_user_id_idx'));
        assert.ok(indexNames.includes('auth_sessions_active_user_idx'));
      });

      await t.test('creates the stream lifecycle contract, checks and indexes', async () => {
        const columns = await pools.empty.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'streams'
          ORDER BY ordinal_position
        `);
        const columnNames = columns.rows.map((row) => row.column_name);
        for (const name of [
          'provider',
          'status',
          'expires_at',
          'resolved_at',
          'last_verified_at',
          'failure_count',
          'last_failure_at',
          'next_retry_at',
          'last_error_code',
        ]) {
          assert.ok(columnNames.includes(name));
        }

        const constraints = await pools.empty.query(`
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'streams'::regclass
        `);
        const constraintNames = constraints.rows.map((row) => row.conname);
        assert.ok(constraintNames.includes('streams_status_check'));
        assert.ok(constraintNames.includes('streams_failure_count_check'));
        assert.ok(constraintNames.includes('streams_last_error_code_check'));

        const indexes = await pools.empty.query(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'streams'
        `);
        const indexNames = indexes.rows.map((row) => row.indexname);
        assert.ok(indexNames.includes('streams_lifecycle_lookup_idx'));
        assert.ok(indexNames.includes('streams_retry_idx'));

        await assert.rejects(
          pools.empty.query(`
            INSERT INTO streams (content_type, content_id, status)
            VALUES ('movie', $1, 'arbitrary')
          `, [crypto.randomUUID()]),
          (error) => error.code === '23514'
        );
      });

      await t.test('creates the persistent stream job contract and indexes', async () => {
        const columns = await pools.empty.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'stream_resolution_jobs'
          ORDER BY ordinal_position
        `);
        assert.deepEqual(columns.rows.map((row) => row.column_name), [
          'id',
          'content_type',
          'content_id',
          'status',
          'attempt_count',
          'max_attempts',
          'run_after',
          'locked_at',
          'locked_by',
          'last_error_code',
          'created_at',
          'updated_at',
          'started_at',
          'completed_at',
        ]);

        const constraints = await pools.empty.query(`
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'stream_resolution_jobs'::regclass
        `);
        const constraintNames = constraints.rows.map((row) => row.conname);
        for (const name of [
          'stream_resolution_jobs_content_type_check',
          'stream_resolution_jobs_status_check',
          'stream_resolution_jobs_attempt_count_check',
          'stream_resolution_jobs_max_attempts_check',
          'stream_resolution_jobs_lock_check',
          'stream_resolution_jobs_last_error_code_check',
        ]) {
          assert.ok(constraintNames.includes(name));
        }

        const indexes = await pools.empty.query(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'stream_resolution_jobs'
        `);
        const indexNames = indexes.rows.map((row) => row.indexname);
        assert.ok(indexNames.includes('stream_resolution_jobs_active_content_idx'));
        assert.ok(indexNames.includes('stream_resolution_jobs_claim_idx'));
        assert.ok(indexNames.includes('stream_resolution_jobs_lease_idx'));

        await assert.rejects(
          pools.empty.query(
            `INSERT INTO stream_resolution_jobs
               (content_type, content_id, attempt_count, max_attempts)
             VALUES ('movie', $1, 2, 1)`,
            [crypto.randomUUID()]
          ),
          (error) => error.code === '23514'
        );
      });

      await t.test('upserts one logical NULL-named stream predictably', async () => {
        const {
          upsertStreamWithClient,
        } = require('../../src/db/streams.queries');

        const contentId = crypto.randomUUID();
        const first = await upsertStreamWithClient(pools.empty, {
          content_type: 'movie',
          content_id: contentId,
          server_name: null,
          quality: '720p',
          language: 'es',
          stream_url: 'https://example.test/first.m3u8',
          embed_url: null,
          stream_type: 'direct',
          priority: 2,
        });
        const second = await upsertStreamWithClient(pools.empty, {
          content_type: 'movie',
          content_id: contentId,
          server_name: null,
          quality: '1080p',
          language: 'es',
          stream_url: 'https://example.test/second.m3u8',
          embed_url: null,
          stream_type: 'direct',
          priority: 1,
        });

        assert.equal(second.id, first.id);
        const result = await pools.empty.query(
          `SELECT id, stream_url, quality
           FROM streams
           WHERE content_type = 'movie'
             AND content_id = $1
             AND server_name IS NULL`,
          [contentId]
        );
        assert.equal(result.rowCount, 1);
        assert.equal(result.rows[0].stream_url, 'https://example.test/second.m3u8');
        assert.equal(result.rows[0].quality, '1080p');
      });

      await t.test('upgrades the legacy schema without losing existing rows', async () => {
        const legacySql = await fs.readFile(
          path.join(DEFAULT_MIGRATIONS_DIR, '001_legacy_baseline.sql'),
          'utf8'
        );
        await pools.legacy.query(legacySql);

        const movie = await pools.legacy.query(
          `INSERT INTO movies (title, is_published)
           VALUES ('Legacy movie', TRUE)
           RETURNING id`
        );
        const stream = await pools.legacy.query(
          `INSERT INTO streams
             (content_type, content_id, server_name, stream_url)
           VALUES ('movie', $1, NULL, 'https://example.test/legacy.m3u8')
           RETURNING id`,
          [movie.rows[0].id]
        );
        const legacyUser = await pools.legacy.query(
          `INSERT INTO users (email, password_hash, refresh_token)
           VALUES ('legacy@example.test', 'legacy-password-hash', 'legacy-plaintext-token')
           RETURNING id`
        );

        await runMigrations({
          pool: pools.legacy,
          logger: silentLogger,
        });

        const preservedMovie = await pools.legacy.query(
          'SELECT id FROM movies WHERE id = $1',
          [movie.rows[0].id]
        );
        const preservedStream = await pools.legacy.query(
          `SELECT id, stream_url, status, last_verified_at, expires_at
           FROM streams WHERE id = $1`,
          [stream.rows[0].id]
        );
        assert.equal(preservedMovie.rowCount, 1);
        assert.equal(preservedStream.rowCount, 1);
        assert.equal(
          preservedStream.rows[0].stream_url,
          'https://example.test/legacy.m3u8'
        );
        assert.equal(preservedStream.rows[0].status, 'unknown');
        assert.equal(preservedStream.rows[0].last_verified_at, null);
        assert.equal(preservedStream.rows[0].expires_at, null);

        const preservedUser = await pools.legacy.query(
          'SELECT id, refresh_token FROM users WHERE id = $1',
          [legacyUser.rows[0].id]
        );
        assert.equal(preservedUser.rowCount, 1);
        assert.equal(preservedUser.rows[0].refresh_token, null);

        const contract = await pools.legacy.query(`
          SELECT
            to_regclass('subtitles') IS NOT NULL AS has_subtitles,
            EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'streams'::regclass
                AND conname = 'streams_content_server_unique'
            ) AS has_stream_constraint,
            to_regclass('auth_sessions') IS NOT NULL AS has_auth_sessions
            ,to_regclass('stream_resolution_jobs') IS NOT NULL AS has_stream_jobs
        `);
        assert.equal(contract.rows[0].has_subtitles, true);
        assert.equal(contract.rows[0].has_stream_constraint, true);
        assert.equal(contract.rows[0].has_auth_sessions, true);
        assert.equal(contract.rows[0].has_stream_jobs, true);
      });

      await t.test('refuses ambiguous legacy duplicates without deleting them', async () => {
        const legacySql = await fs.readFile(
          path.join(DEFAULT_MIGRATIONS_DIR, '001_legacy_baseline.sql'),
          'utf8'
        );
        await pools.duplicate.query(legacySql);
        const contentId = crypto.randomUUID();
        await pools.duplicate.query(
          `INSERT INTO streams
             (content_type, content_id, server_name, stream_url)
           VALUES
             ('movie', $1, NULL, 'https://example.test/a.m3u8'),
             ('movie', $1, NULL, 'https://example.test/b.m3u8')`,
          [contentId]
        );

        await assert.rejects(
          runMigrations({
            pool: pools.duplicate,
            logger: silentLogger,
          }),
          /logical duplicate streams exist/
        );

        const rows = await pools.duplicate.query(
          'SELECT id FROM streams WHERE content_id = $1',
          [contentId]
        );
        assert.equal(rows.rowCount, 2);
      });
    } finally {
      for (const pool of Object.values(pools)) {
        await pool.end();
      }

      const configuredPool = require('../../src/config/db');
      await configuredPool.end().catch(() => {});

      for (const schema of Object.values(schemas)) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await adminPool.end();
    }
  }
);
