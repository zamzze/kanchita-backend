'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createProviderMediaMappingStore, normalizeLookup, normalizeMapping } =
  require('../src/db/providerMediaMappings.queries');

test('mapping input is generic, strict and episode-ready', () => {
  assert.deepEqual(normalizeLookup({ providerId: 'PLUTO', region: 'LATAM',
    contentType: 'movie', tmdbId: 550 }), { providerId: 'pluto', region: 'latam',
    contentType: 'movie', tmdbId: 550, seasonNumber: null, episodeNumber: null,
    status: null });
  assert.equal(normalizeLookup({ providerId: 'pluto', region: 'latam',
    contentType: 'episode', tmdbId: 10, seasonNumber: 1 }), null);
  assert.equal(normalizeLookup({ providerId: 'pluto', region: 'latam',
    contentType: 'movie', tmdbId: 1, seasonNumber: 1 }), null);
  assert.equal(normalizeMapping({ providerId: 'pluto', region: 'latam',
    contentType: 'movie', tmdbId: 0, externalId: 'x' }), null);
});

test('active lookup has deterministic ordering and inactive updates exact identity', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.startsWith('SELECT') ? [{ id: 9, external_id: 'external' }]
      : [{ id: 9, status: 'inactive' }] };
  } };
  const store = createProviderMediaMappingStore(db);
  assert.equal((await store.findActiveMapping({ providerId: 'pluto', region: 'latam',
    contentType: 'movie', tmdbId: 550 })).id, 9);
  assert.match(calls[0].sql,
    /status = 'active'.*last_verified_at DESC NULLS LAST, updated_at DESC, id DESC/s);
  assert.deepEqual(calls[0].values, ['pluto', 'latam', 'movie', 550, null, null]);
  await store.markInactive({ providerId: 'pluto', region: 'latam',
    contentType: 'movie', externalId: 'external' });
  assert.deepEqual(calls[1].values, ['pluto', 'latam', 'movie', 'external']);
});

test('active plural lookup returns every mapping in SQL order while singular returns first',
  async () => {
    const ordered = [
      { id: 2, external_id: 'newer', last_verified_at: '2025-01-01T00:00:00Z' },
      { id: 1, external_id: 'older', last_verified_at: '2024-01-01T00:00:00Z' },
    ];
    const calls = [];
    const store = createProviderMediaMappingStore({ query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: ordered };
    } });
    const lookup = { providerId: 'pluto', region: 'latam', contentType: 'movie',
      tmdbId: 550 };
    assert.deepEqual(await store.findActiveMappings(lookup), ordered);
    assert.equal((await store.findActiveMapping(lookup)).external_id, 'newer');
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.sql,
        /status = 'active'.*last_verified_at DESC NULLS LAST, updated_at DESC, id DESC/s);
      assert.deepEqual(call.values, ['pluto', 'latam', 'movie', 550, null, null]);
    }
  });

test('upsert reports inserted, updated and unchanged without deleting other mappings', async () => {
  const base = { providerId: 'pluto', region: 'latam', contentType: 'movie', tmdbId: 550,
    externalId: '0123456789abcdef01234567', providerTitle: 'Movie', status: 'active' };
  for (const [rows, expected] of [
    [[{ id: 1, inserted: true }], 'inserted'],
    [[{ id: 1, inserted: false }], 'updated'],
  ]) {
    const store = createProviderMediaMappingStore({ query: async () => ({ rows }) });
    assert.equal((await store.upsertMapping(base)).change, expected);
  }
  let calls = 0;
  const unchanged = createProviderMediaMappingStore({ query: async () => {
    calls += 1;
    return calls === 1 ? { rows: [] } : { rows: [{ id: 1, tmdb_id: 550,
      season_number: null, episode_number: null }] };
  } });
  assert.equal((await unchanged.upsertMapping(base)).change, 'unchanged');
  assert.equal(calls, 2);

  calls = 0;
  const conflict = createProviderMediaMappingStore({ query: async () => {
    calls += 1;
    return calls === 1 ? { rows: [] } : { rows: [{ id: 1, tmdb_id: 999,
      season_number: null, episode_number: null }] };
  } });
  assert.equal((await conflict.upsertMapping(base)).change, 'conflict');
});

const TEST_DB_URL = process.env.TEST_DB_URL;
test('PostgreSQL mapping store preserves history and selects active mapping deterministically',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run PostgreSQL mapping integration tests' },
  async () => {
    const schema = `kanchita_mapping_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Pool({ connectionString: TEST_DB_URL });
    let pool;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: TEST_DB_URL,
        options: `-c search_path=${schema},public` });
      await runMigrations({ pool, logger: { log() {} } });
      const store = createProviderMediaMappingStore(pool);
      const first = await store.upsertMapping({ providerId: 'pluto', region: 'latam',
        contentType: 'movie', tmdbId: 550, externalId: '0123456789abcdef01234567',
        providerTitle: 'First', status: 'active', lastVerifiedAt: '2024-01-01T00:00:00Z' });
      const second = await store.upsertMapping({ providerId: 'pluto', region: 'latam',
        contentType: 'movie', tmdbId: 550, externalId: 'abcdef0123456789abcdef01',
        providerTitle: 'Second', status: 'active', lastVerifiedAt: '2025-01-01T00:00:00Z' });
      assert.equal(first.change, 'inserted');
      assert.equal(second.change, 'inserted');
      assert.equal((await store.findMappings({ providerId: 'pluto', region: 'latam',
        contentType: 'movie', tmdbId: 550 })).length, 2);
      const activeMappings = await store.findActiveMappings({ providerId: 'pluto',
        region: 'latam', contentType: 'movie', tmdbId: 550 });
      assert.deepEqual(activeMappings.map(({ external_id }) => external_id),
        [second.external_id, first.external_id]);
      assert.equal((await store.findActiveMapping({ providerId: 'pluto', region: 'latam',
        contentType: 'movie', tmdbId: 550 })).external_id, second.external_id);
      await store.markInactive({ providerId: 'pluto', region: 'latam', contentType: 'movie',
        externalId: second.external_id });
      assert.equal((await store.findActiveMapping({ providerId: 'pluto', region: 'latam',
        contentType: 'movie', tmdbId: 550 })).external_id, first.external_id);
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
