'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createCatalogSeedStore } = require('../src/db/catalogSeed.queries');
const { createCatalogSeeder, normalizeCatalogItem, parseCatalogArgs } =
  require('../src/ingestion/catalogSeeder');
const tmdbClient = require('../src/ingestion/tmdb/tmdbClient');
const { discoverCatalogPage } = require('../src/ingestion/tmdb/tmdbFetcher');

const movie = (id, title = `Movie ${id}`) => ({ id, title, original_title: title,
  release_date: '2025-01-01', overview: 'Fixture', adult: false });
const series = (id, name = `Series ${id}`) => ({ id, name, original_name: name,
  first_air_date: '2025-01-01', overview: 'Fixture', adult: false });
const config = (movieTarget = 2, seriesTarget = 1, batchSize = 2) => ({
  targets: { movie: movieTarget, series: seriesTarget }, batchSize,
  maxPages: 2, startYear: 2025, minYear: 2024,
});
const fixturePages = ({ movies = [[movie(1), movie(2)]],
  shows = [[series(3)]], failures = {} } = {}) => {
  const calls = [];
  const fetchPage = async (type, year, page) => {
    calls.push({ type, year, page });
    if (failures[`${type}:${year}:${page}`]) throw failures[`${type}:${year}:${page}`];
    const pages = type === 'movie' ? movies : shows;
    const results = year === 2025 ? pages[page - 1] || [] : [];
    return { results, total_pages: pages.length };
  };
  return { fetchPage, calls };
};

const fakeStore = () => {
  const rows = { movie: new Map(), series: new Map() };
  const runs = new Map();
  const calls = [];
  const clone = (value) => structuredClone(value);
  const createRun = async (cfg) => {
    const refreshExisting = rows.movie.size >= cfg.targets.movie &&
      rows.series.size >= cfg.targets.series;
    const progress = refreshExisting ? { movie: 0, series: 0 } : {
      movie: Math.min(rows.movie.size, cfg.targets.movie),
      series: Math.min(rows.series.size, cfg.targets.series) };
    const run = { id: randomUUID(), status: 'pending', config_json: clone(cfg),
      checkpoint_json: { refreshExisting,
      seenTmdbIds: refreshExisting ? { movie: [], series: [] } : null,
      cursor: Object.fromEntries(['movie', 'series'].map((type) =>
        [type, { year: cfg.startYear, page: 1, offset: 0,
          done: progress[type] >= cfg.targets[type] }])), progress,
      stats: { inserted: 0, updated: 0, unchanged: 0, failed: 0 },
      pages: { movie: 0, series: 0 } } };
    runs.set(run.id, run);
    return clone(run);
  };
  const getRun = async (id) => clone(runs.get(id));
  const resumeRun = async (id) => {
    const run = runs.get(id);
    if (!run || run.status === 'completed') return null;
    run.status = 'running';
    return clone(run);
  };
  const commitBatch = async ({ runId, type, expectedCursor, nextCursor,
    items, failed = 0, pageFinished = false }) => {
    const run = runs.get(runId);
    assert.deepEqual(run.checkpoint_json.cursor[type], expectedCursor);
    const stats = run.checkpoint_json.stats;
    for (const item of items) {
      const prior = rows[type].get(item.tmdb_id);
      if (!prior) { rows[type].set(item.tmdb_id, { ...item, id: randomUUID() }); stats.inserted += 1; }
      else if (JSON.stringify({ ...prior, id: null }) !==
          JSON.stringify({ ...item, id: null })) {
        rows[type].set(item.tmdb_id, { ...item, id: prior.id }); stats.updated += 1;
      } else stats.unchanged += 1;
    }
    stats.failed += failed;
    run.checkpoint_json.cursor[type] = clone(nextCursor);
    if (run.checkpoint_json.refreshExisting) {
      const visited = new Set(run.checkpoint_json.seenTmdbIds[type]);
      for (const item of items) visited.add(item.tmdb_id);
      run.checkpoint_json.seenTmdbIds[type] = [...visited];
      run.checkpoint_json.progress[type] = Math.min(visited.size,
        run.config_json.targets[type]);
    } else {
      run.checkpoint_json.progress[type] = Math.min(rows[type].size,
        run.config_json.targets[type]);
    }
    if (run.checkpoint_json.progress[type] >= run.config_json.targets[type]) {
      run.checkpoint_json.cursor[type].done = true;
    }
    if (pageFinished) run.checkpoint_json.pages[type] += 1;
    calls.push({ type, cursor: clone(run.checkpoint_json.cursor[type]),
      progress: clone(run.checkpoint_json.progress) });
    return { run: clone(run) };
  };
  const completeRun = async (id) => {
    const run = runs.get(id); run.status = 'completed'; return clone(run);
  };
  const markFailed = async (id, code) => {
    const run = runs.get(id); run.status = 'failed'; run.last_error_code = code;
    run.checkpoint_json.stats.failed += 1;
    return clone(run);
  };
  return { rows, runs, calls, createRun, getRun, resumeRun,
    commitBatch, completeRun, markFailed };
};

const seedWith = (fetchPage, store = fakeStore(), more = {}) =>
  createCatalogSeeder({ fetchPage, store, requestPauseMs: 0,
    sleep: async () => {}, ...more });

test('strict CLI arguments and independent movie/series targets', () => {
  assert.deepEqual(parseCatalogArgs(['--movies', '12', '--series', '8']).config.targets,
    { movie: 12, series: 8 });
  assert.deepEqual(parseCatalogArgs(['--target', '20', '--movie-ratio', '0.65']).config.targets,
    { movie: 13, series: 7 });
  for (const args of [['--bad'], ['--target', '0'], ['--target', '1', '--movies', '1'],
    ['--batch-size', '101'], ['--resume', 'not-a-uuid'], ['--dry-run', '--dry-run'],
    ['--movie-ratio', '0'], ['--max-pages', '501']]) {
    assert.throws(() => parseCatalogArgs(args), { code: 'CATALOG_CLI_INVALID_ARGS' });
  }
});

test('normalizer reuses catalog columns and rejects unusable items', () => {
  assert.equal(normalizeCatalogItem('movie', movie(1)).tmdb_id, 1);
  assert.equal(normalizeCatalogItem('series', series(2)).original_title, 'Series 2');
  assert.equal(normalizeCatalogItem('movie', { id: 3 }), null);
  assert.equal(normalizeCatalogItem('episode', movie(1)), null);
});

test('TMDB discovery partitions movies and TV by explicit calendar year', async () => {
  const calls = [];
  const original = tmdbClient.get;
  tmdbClient.get = async (path, params) => { calls.push({ path, params }); return {}; };
  try {
    await discoverCatalogPage('movie', 2025, 2);
    await discoverCatalogPage('series', 2024, 1);
  } finally { tmdbClient.get = original; }
  assert.equal(calls[0].path, '/discover/movie');
  assert.equal(calls[0].params['primary_release_date.gte'], '2025-01-01');
  assert.equal(calls[0].params['primary_release_date.lte'], '2025-12-31');
  assert.equal(calls[1].path, '/discover/tv');
  assert.equal(calls[1].params['first_air_date.gte'], '2024-01-01');
  assert.throws(() => discoverCatalogPage('episode', 2025, 1),
    { code: 'TMDB_DISCOVER_INVALID_INPUT' });
});

test('movie and series pages, cursors, batch checkpoints and target cap', async () => {
  const { fetchPage, calls } = fixturePages({
    movies: [[movie(1), movie(2), movie(3)], [movie(4)]],
    shows: [[series(5)], [series(6)]] });
  const store = fakeStore();
  const result = await seedWith(fetchPage, store).run({ config: config(4, 2, 2) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.checkpoint.progress, { movie: 4, series: 2 });
  assert.equal(result.checkpoint.stats.inserted, 6);
  assert.ok(store.calls.some((item) => item.type === 'movie' && item.cursor.offset === 2));
  assert.equal(result.checkpoint.pages.movie, 2);
  assert.equal(result.checkpoint.pages.series, 2);
  assert.deepEqual(calls.map((item) => item.type),
    ['movie', 'movie', 'movie', 'series', 'series']);
});

test('duplicates within/across pages do not create duplicate catalog identities', async () => {
  const { fetchPage } = fixturePages({
    movies: [[movie(1), movie(1)], [movie(1), movie(2)]], shows: [] });
  const store = fakeStore();
  const result = await seedWith(fetchPage, store).run({ config: config(2, 0) });
  assert.equal(store.rows.movie.size, 2);
  assert.equal(result.checkpoint.stats.inserted, 2);
  assert.ok(result.checkpoint.stats.unchanged >= 1);
});

test('small target never inserts an entire oversized page', async () => {
  const { fetchPage } = fixturePages({ movies: [[movie(1), movie(2), movie(3)]],
    shows: [] });
  const store = fakeStore();
  await seedWith(fetchPage, store).run({ config: config(1, 0) });
  assert.deepEqual([...store.rows.movie.keys()], [1]);
});

test('duplicate updates metadata but retains internal id; completed repeat is idempotent',
  async () => {
    const { fetchPage } = fixturePages({ movies: [[movie(1, 'Old'), movie(2)]],
      shows: [] });
    const store = fakeStore();
    await seedWith(fetchPage, store).run({ config: config(2, 0) });
    const original = store.rows.movie.get(1);
    const refreshed = fixturePages({ movies: [[movie(1, 'New'), movie(2)]], shows: [] });
    const result = await seedWith(refreshed.fetchPage, store).run({ config: config(2, 0) });
    assert.equal(store.rows.movie.size, 2);
    assert.equal(store.rows.movie.get(1).id, original.id);
    assert.equal(store.rows.movie.get(1).title, 'New');
    assert.equal(result.checkpoint.stats.updated, 1);
    assert.equal(result.checkpoint.stats.unchanged, 1);
  });

test('failed API page is recorded and resume uses saved cursor', async () => {
  const error = Object.assign(new Error('private detail'), { code: 'TMDB_HTTP_ERROR', status: 400 });
  const fixture = fixturePages({ movies: [[movie(1)], [movie(2)]], shows: [],
    failures: { 'movie:2025:2': error } });
  const store = fakeStore();
  await assert.rejects(seedWith(fixture.fetchPage, store).run({ config: config(2, 0) }),
    { code: 'TMDB_HTTP_ERROR' });
  const run = [...store.runs.values()][0];
  assert.equal(run.status, 'failed');
  assert.equal(run.checkpoint_json.stats.failed, 1);
  assert.equal(run.checkpoint_json.cursor.movie.page, 2);
  const resumed = fixturePages({ movies: [[movie(1)], [movie(2)]], shows: [] });
  const result = await seedWith(resumed.fetchPage, store).run({ resume: run.id });
  assert.equal(result.status, 'completed');
  assert.deepEqual(resumed.calls.map(({ page }) => page), [2]);
});

test('transient failure retries finitely and honors bounded backoff', async () => {
  const fixture = fixturePages({ movies: [[movie(1)]], shows: [] });
  let attempts = 0;
  const delays = [];
  const fetchPage = async (...args) => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('429'),
      { code: 'TMDB_HTTP_ERROR', status: 429, retryAfterMs: 7_000 });
    return fixture.fetchPage(...args);
  };
  await seedWith(fetchPage, fakeStore(), { sleep: async (ms) => delays.push(ms) })
    .run({ config: config(1, 0) });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5_000, 5_000]);
});

test('dry-run reads pages without creating a run or writing rows', async () => {
  const { fetchPage } = fixturePages();
  const result = await seedWith(fetchPage, null).run({ dryRun: true,
    config: config(2, 1) });
  assert.equal(result.runId, null);
  assert.deepEqual(result.checkpoint.progress, { movie: 2, series: 1 });
  assert.equal(result.checkpoint.stats.inserted, 0);
});

test('partition advances by year when a year has no more pages', async () => {
  const calls = [];
  const fetchPage = async (type, year, page) => {
    calls.push({ type, year, page });
    return { results: type === 'movie' && year === 2024 ? [movie(1)] : [],
      total_pages: 1 };
  };
  const result = await seedWith(fetchPage).run({ dryRun: true,
    config: config(1, 0) });
  assert.equal(result.checkpoint.progress.movie, 1);
  assert.deepEqual(calls.map(({ year }) => year), [2025, 2024]);
});

test('PostgreSQL catalog seed preserves IDs, checkpoint and idempotence',
  { skip: process.env.TEST_DB_URL ? false : 'Set TEST_DB_URL for PostgreSQL integration' },
  async () => {
    const schema = `kanchita_catalog_seed_${randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
    const db = new Pool({ connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations({ pool: db, logger: { log() {} } });
      const store = createCatalogSeedStore(db);
      const fixture = fixturePages({ movies: [[movie(71001)],
        [movie(71001, 'Updated'), movie(71002)]], shows: [[series(72001)]] });
      const initial = await seedWith(fixture.fetchPage, store).run({ config: config(2, 1) });
      assert.equal(initial.status, 'completed');
      assert.equal(initial.checkpoint.stats.inserted, 3);
      assert.equal(initial.checkpoint.stats.updated, 1);
      const before = await db.query('SELECT id,title FROM movies WHERE tmdb_id = 71001');
      assert.equal(before.rows[0].title, 'Updated');
      const repeat = await seedWith(fixture.fetchPage, store).run({ config: config(2, 1) });
      assert.equal(repeat.status, 'completed');
      assert.equal(fixture.calls.length, 8);
      const after = await db.query('SELECT id FROM movies WHERE tmdb_id = 71001');
      assert.equal(after.rows[0].id, before.rows[0].id);
      assert.deepEqual(await store.catalogCounts(), { movie: 2, series: 1 });
      const showBefore = await db.query(`UPDATE series SET status='ended',
        is_published=FALSE WHERE tmdb_id=72001 RETURNING id`);
      const refresh = fixturePages({ movies: [],
        shows: [[series(72001, 'Series updated'), series(72002)]] });
      await seedWith(refresh.fetchPage, store).run({ config: config(2, 2) });
      const showAfter = await db.query(`SELECT id,status,is_published,title
        FROM series WHERE tmdb_id=72001`);
      assert.equal(showAfter.rows[0].id, showBefore.rows[0].id);
      assert.equal(showAfter.rows[0].status, 'ended');
      assert.equal(showAfter.rows[0].is_published, false);
      assert.equal(showAfter.rows[0].title, 'Series updated');
      const interrupted = fixturePages({ movies: [[movie(73001)], [movie(73002)]],
        shows: [], failures: { 'movie:2025:2': Object.assign(new Error('fail'),
          { code: 'TMDB_HTTP_ERROR', status: 400 }) } });
      await assert.rejects(seedWith(interrupted.fetchPage, store).run({
        config: config(4, 2) }));
      const failedRun = (await db.query(`SELECT * FROM ingestion_runs
        WHERE status='failed' AND run_type='catalog_seed' ORDER BY created_at DESC LIMIT 1`))
        .rows[0];
      assert.equal(failedRun.checkpoint_json.cursor.movie.page, 2);
      assert.equal(failedRun.failed_count, 1);
      const resumed = fixturePages({ movies: [[movie(73001)], [movie(73002)]], shows: [] });
      const end = await seedWith(resumed.fetchPage, store).run({ resume: failedRun.id });
      assert.equal(end.status, 'completed');
      assert.deepEqual(resumed.calls.map(({ page }) => page), [2]);
      assert.deepEqual(await store.catalogCounts(), { movie: 4, series: 2 });
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
