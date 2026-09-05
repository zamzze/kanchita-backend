'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_NAME = 'kanchita_schema_migrations';
const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

const checksum = (sql) =>
  crypto.createHash('sha256').update(sql, 'utf8').digest('hex');

const loadMigrations = async (migrationsDir = DEFAULT_MIGRATIONS_DIR) => {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(fileNames.map(async (version) => {
    const sql = await fs.readFile(path.join(migrationsDir, version), 'utf8');
    return { version, sql, checksum: checksum(sql) };
  }));
};

const ensureMigrationTable = (client) =>
  client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

const runMigrations = async ({
  pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  logger = console,
} = {}) => {
  if (!pool) {
    throw new Error('runMigrations requires a PostgreSQL pool');
  }

  const migrations = await loadMigrations(migrationsDir);
  const client = await pool.connect();
  const applied = [];
  const skipped = [];

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [LOCK_NAME]);
    await ensureMigrationTable(client);

    const result = await client.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    const recorded = new Map(
      result.rows.map((row) => [row.version, row.checksum.trim()])
    );

    for (const migration of migrations) {
      const recordedChecksum = recorded.get(migration.version);

      if (recordedChecksum) {
        if (recordedChecksum !== migration.checksum) {
          throw new Error(
            `Applied migration ${migration.version} has a different checksum`
          );
        }
        skipped.push(migration.version);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum]
        );
        await client.query('COMMIT');
        applied.push(migration.version);
        logger.log(`[Migrate] Applied ${migration.version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.version} failed: ${error.message}`,
          { cause: error }
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [LOCK_NAME])
      .catch(() => {});
    client.release();
  }
};

const main = async () => {
  if (!process.env.DB_URL) {
    throw new Error('Missing required env var: DB_URL');
  }

  const pool = new Pool({ connectionString: process.env.DB_URL });
  try {
    const result = await runMigrations({ pool });
    console.log(
      `[Migrate] Complete: ${result.applied.length} applied, ` +
      `${result.skipped.length} already current`
    );
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Migrate] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations,
};
