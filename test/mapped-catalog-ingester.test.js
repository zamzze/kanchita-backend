'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createCatalogSeedStore } = require('../src/db/catalogSeed.queries');
const { createMappedCatalogIngester, parseMappedCatalogArgs } =
  require('../src/ingestion/mappedCatalogIngester');

const movie = (id) => ({ id, title: `Movie ${id}`, original_title: `Movie ${id}`,
  overview: 'Fixture', release_date: '2025-01-01', adult: false });
const series = (id) => ({ id, name: `Series ${id}`, original_name: `Series ${id}`,
  overview: 'Fixture', first_air_date: '2025-01-01', adult: false });
const identity = (type, id, present = false) => ({ catalog_type: type,
  tmdb_id: id, already_present: present });

const fakeStore = (mappingRows) => {
  const catalog = { movie: new Map(), series: new Map() };
  const originalMappings = structuredClone(mappingRows);
  return {
    catalog, originalMappings, mappingRows,
    listMappedIdentities: async () => mappingRows.map((row) => ({ ...row,
      already_present: catalog[row.catalog_type]?.has(row.tmdb_id) ||
        row.already_present })),
    upsertItem: async (type, item) => {
      const old = catalog[type].get(item.tmdb_id);
      catalog[type].set(item.tmdb_id, item);
      return !old ? 'inserted' : old.title === item.title ? 'unchanged' : 'updated';
    },
  };
};

const makeIngester = (store, calls = []) => createMappedCatalogIngester({ store,
  fetchMovie: async (id) => { calls.push(`movie:${id}`); return movie(id); },
  fetchSeries: async (id) => { calls.push(`series:${id}`); return series(id); },
  sleep: async () => {}, pauseMs: 0 });

test('CLI requires an exact provider and validates a bounded optional limit', () => {
  assert.deepEqual(parseMappedCatalogArgs(['--provider', 'pluto']),
    { providerId: 'pluto', limit: null });
  assert.deepEqual(parseMappedCatalogArgs(['--limit', '3', '--provider', 'pluto']),
    { providerId: 'pluto', limit: 3 });
  for (const args of [[], ['--provider', 'BAD'], ['--provider', 'pluto', '--limit', '0'],
    ['--provider', 'pluto', '--limit', '10001'], ['--provider', 'pluto', '--bogus', '1'],
    ['--provider', 'pluto', '--provider', 'pluto']]) {
    assert.throws(() => parseMappedCatalogArgs(args),
      { code: 'MAPPED_CATALOG_INVALID_ARGS' });
  }
});

test('already present is skipped; one missing movie and series are inserted', async () => {
  const store = fakeStore([identity('movie', 1, true), identity('movie', 2),
    identity('series', 3)]);
  const calls = [];
  const result = await makeIngester(store, calls).run({ providerId: 'pluto' });
  assert.deepEqual(result, { requested: 3, alreadyPresent: 1,
    inserted: 2, updated: 0, notFound: 0, failed: 0 });
  assert.deepEqual(calls, ['movie:2', 'series:3']);
  assert.equal(store.catalog.movie.size, 1);
  assert.equal(store.catalog.series.size, 1);
  assert.deepEqual(store.mappingRows, store.originalMappings);
});

test('duplicate active mappings of one TMDB identity are fetched once', async () => {
  const store = fakeStore([identity('movie', 8), identity('movie', 8),
    identity('series', 8)]);
  const calls = [];
  const result = await makeIngester(store, calls).run({ providerId: 'pluto' });
  assert.equal(result.requested, 2);
  assert.deepEqual(calls, ['movie:8', 'series:8']);
});

test('rerun is idempotent and does not mutate the mappings', async () => {
  const store = fakeStore([identity('movie', 9), identity('series', 10)]);
  const calls = [];
  const ingester = makeIngester(store, calls);
  assert.equal((await ingester.run({ providerId: 'pluto' })).inserted, 2);
  const second = await ingester.run({ providerId: 'pluto' });
  assert.deepEqual(second, { requested: 2, alreadyPresent: 2,
    inserted: 0, updated: 0, notFound: 0, failed: 0 });
  assert.deepEqual(calls, ['movie:9', 'series:10']);
  assert.deepEqual(store.mappingRows, store.originalMappings);
});

test('404 is notFound; other failures and mismatched TMDB identities are failed', async () => {
  const store = fakeStore([identity('movie', 11), identity('series', 12),
    identity('movie', 13)]);
  const ingester = createMappedCatalogIngester({ store, pauseMs: 0,
    fetchMovie: async (id) => {
      if (id === 11) throw Object.assign(new Error('not found'),
        { code: 'TMDB_HTTP_ERROR', status: 404 });
      return movie(999);
    },
    fetchSeries: async () => { throw Object.assign(new Error('invalid'),
      { code: 'TMDB_HTTP_ERROR', status: 401 }); },
    sleep: async () => {} });
  assert.deepEqual(await ingester.run({ providerId: 'pluto' }),
    { requested: 3, alreadyPresent: 0, inserted: 0, updated: 0,
      notFound: 1, failed: 2 });
  assert.equal(store.catalog.movie.size, 0);
  assert.deepEqual(store.mappingRows, store.originalMappings);
});

test('limit applies before presence filtering so a repeat selects the same IDs', async () => {
  const store = fakeStore([identity('movie', 1), identity('movie', 2),
    identity('movie', 3)]);
  const calls = [];
  const ingester = makeIngester(store, calls);
  assert.equal((await ingester.run({ providerId: 'pluto', limit: 2 })).inserted, 2);
  assert.equal((await ingester.run({ providerId: 'pluto', limit: 2 })).alreadyPresent, 2);
  assert.deepEqual(calls, ['movie:1', 'movie:2']);
});

test('transient TMDB failures retry finitely with bounded Retry-After', async () => {
  const store = fakeStore([identity('movie', 22)]);
  let attempts = 0;
  const delays = [];
  const ingester = createMappedCatalogIngester({ store, pauseMs: 0,
    fetchMovie: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('rate limited'),
        { status: 429, retryAfterMs: 9_000 });
      return movie(22);
    }, fetchSeries: async () => { throw new Error('unexpected'); },
    sleep: async (ms) => delays.push(ms) });
  assert.equal((await ingester.run({ providerId: 'pluto' })).inserted, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5_000, 5_000]);
});

test('PostgreSQL union deduplicates mappings and never updates mapping rows',
  { skip: process.env.TEST_DB_URL ? false : 'Set TEST_DB_URL for PostgreSQL integration' },
  async () => {
    const schema = `kanchita_mapped_catalog_${randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
    const db = new Pool({ connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations({ pool: db, logger: { log() {} } });
      for (const [type, id, season, episode, external, status] of [
        ['movie', 101, null, null, 'one', 'active'],
        ['movie', 101, null, null, 'two', 'active'],
        ['episode', 201, 1, 1, 'ep-one', 'active'],
        ['episode', 201, 1, 2, 'ep-two', 'active'],
        ['movie', 301, null, null, 'inactive', 'inactive'],
      ]) {
        await db.query(`INSERT INTO provider_media_mappings
          (provider_id,region,content_type,tmdb_id,season_number,episode_number,external_id,status)
          VALUES ('pluto','latam',$1,$2,$3,$4,$5,$6)`,
        [type, id, season, episode, external, status]);
      }
      await db.query(`INSERT INTO movies (tmdb_id,title) VALUES (101,'Already here')`);
      const before = (await db.query(`SELECT id,provider_id,content_type,tmdb_id,status,
        updated_at FROM provider_media_mappings ORDER BY id`)).rows;
      const store = createCatalogSeedStore(db);
      const rows = await store.listMappedIdentities('pluto');
      assert.deepEqual(rows, [identity('movie', 101, true), identity('series', 201)]);
      const calls = [];
      const first = await makeIngester(store, calls).run({ providerId: 'pluto' });
      assert.deepEqual(first, { requested: 2, alreadyPresent: 1,
        inserted: 1, updated: 0, notFound: 0, failed: 0 });
      assert.deepEqual(calls, ['series:201']);
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS n FROM series`)).rows[0].n, 1);
      const after = (await db.query(`SELECT id,provider_id,content_type,tmdb_id,status,
        updated_at FROM provider_media_mappings ORDER BY id`)).rows;
      assert.deepEqual(after, before);
      assert.equal((await makeIngester(store).run({ providerId: 'pluto' })).inserted, 0);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
