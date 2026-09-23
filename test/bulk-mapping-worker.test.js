'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createBulkMappingStore } = require('../src/db/bulkMapping.queries');
const { createIngestionRunStore } = require('../src/db/ingestionRuns.queries');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { normalizeMedia, normalizeMappingResult } =
  require('../src/ingestion/mappings/mappingContract');
const { createMappingRegistry } =
  require('../src/ingestion/mappings/mappingRegistry');
const { createBulkMappingWorker, formatMappingProgress } =
  require('../src/ingestion/mappings/bulkMappingWorker');
const { parseArgs, createCliRegistry } =
  require('../scripts/ingest-provider-mappings');

const movie = (id, tmdbId = id) => ({ content_type: 'movie', content_id: randomUUID(),
  tmdb_id: tmdbId, title: `Movie ${id}`, original_title: `Movie ${id}`,
  release_year: 2025, season_number: null, episode_number: null });
const episode = (id, tmdbId = id) => ({ content_type: 'episode',
  content_id: randomUUID(), tmdb_id: tmdbId, title: `Series ${id}`,
  original_title: `Series ${id}`, release_year: 2025,
  season_number: 2, episode_number: 3 });
const provider = (id, discoverMapping = async () => [], extra = {}) => ({
  id, enabled: true, priority: 10, supportsMovies: true, supportsSeries: true,
  region: 'latam', maxConcurrent: 1, minDelayMs: 0, discoverMapping, ...extra,
});
const found = (id, externalId = `external-${id}`) => ({ providerId: id,
  externalId, matchMethod: 'exact_id', matchConfidence: 100 });
const mediaKey = (media) => `${media.contentType}:${media.tmdbId}:` +
  `${media.season ?? ''}:${media.episode ?? ''}`;

const fakeStores = (catalog, initialMappings = []) => {
  const mappings = structuredClone(initialMappings);
  const runs = new Map();
  const items = new Map();
  const claims = [];
  const activeFor = (media) => mappings.filter((row) => row.mediaKey === mediaKey(media) &&
    row.status === 'active');
  const progress = (runId) => {
    const selected = [...items.values()].filter((item) => item.run_id === runId);
    const count = (status) => selected.filter((item) => item.status === status).length;
    return { total: selected.length,
      processed: selected.filter((item) => !['pending', 'processing'].includes(item.status)).length,
      mapped: count('completed'), no_mapping: count('no_mapping'),
      skipped: count('skipped'), failed: count('failed'),
      active: count('pending') + count('processing') };
  };
  const bulkStore = {
    listMedia: async (limit) => catalog.slice(0, limit || catalog.length),
    createRunWithItems: async (config) => {
      const id = randomUUID();
      const selected = catalog.slice(0, config.limit || catalog.length);
      const run = { id, run_type: 'provider_mapping', status: 'pending',
        config_json: config, requested_count: selected.length };
      runs.set(id, run);
      for (const row of selected) {
        const item = { id: randomUUID(), run_id: id, status: 'pending',
          content_id: row.content_id, attempt_count: 0 };
        items.set(item.id, item);
      }
      return { ...run };
    },
    loadItemMedia: async (_runId, itemId) => catalog.find((row) =>
      row.content_id === items.get(itemId)?.content_id),
    findActiveMappings: async (media) => activeFor(media),
    withRunLock: async (_id, operation) => operation(),
    recoverRunningRun: async (id) => {
      for (const item of items.values()) {
        if (item.run_id === id && item.status === 'processing') item.status = 'pending';
      }
      return runs.get(id);
    },
    requeueFailed: async (id) => {
      for (const item of items.values()) {
        if (item.run_id === id && item.status === 'failed') item.status = 'pending';
      }
    },
    progress: async (id) => progress(id),
    finishRun: async (id) => {
      const run = runs.get(id);
      run.status = progress(id).failed ? 'failed' : 'completed';
      return { ...run };
    },
    pauseRun: async (id) => { runs.get(id).status = 'paused'; return runs.get(id); },
  };
  const runStore = {
    getRun: async (id) => runs.get(id) || null,
    resumeRun: async (id) => {
      const run = runs.get(id);
      if (!run || !['pending', 'paused', 'failed'].includes(run.status)) return null;
      run.status = 'running'; return { ...run };
    },
    claimNextPendingItems: async (id, limit) => {
      const selected = [...items.values()].filter((item) => item.run_id === id &&
        item.status === 'pending').slice(0, limit);
      for (const item of selected) { item.status = 'processing'; item.attempt_count += 1; }
      claims.push(...selected.map((item) => item.id));
      return selected.map((item) => ({ ...item }));
    },
    markItemCompleted: async ({ itemId, status, mappingCount }) => {
      const item = items.get(itemId);
      item.status = status; item.mapping_count = mappingCount;
      return { ...item };
    },
    markItemFailed: async ({ itemId, code }) => {
      const item = items.get(itemId);
      item.status = 'failed'; item.last_error_code = code;
      return { ...item };
    },
    updateCounters: async () => {},
  };
  const mappingStore = { upsertMapping: async (input) => {
    const key = mediaKey({ contentType: input.contentType, tmdbId: input.tmdbId,
      season: input.seasonNumber, episode: input.episodeNumber });
    const existing = mappings.find((row) => row.mediaKey === key &&
      row.provider_id === input.providerId && row.region === input.region &&
      row.external_id === input.externalId);
    if (existing) {
      existing.status = 'active'; existing.last_verified_at = input.lastVerifiedAt;
      return { change: 'updated' };
    }
    mappings.push({ mediaKey: key, provider_id: input.providerId,
      region: input.region, external_id: input.externalId, status: 'active',
      last_verified_at: input.lastVerifiedAt });
    return { change: 'inserted' };
  } };
  return { bulkStore, runStore, mappingStore, mappings, runs, items, claims };
};

test('mapping contract accepts identity metadata but rejects URLs and secret metadata', () => {
  const media = normalizeMedia({ contentType: 'episode', tmdbId: 100,
    title: 'Show', season: 2, episode: 3 });
  assert.ok(media);
  assert.equal(normalizeMedia({ contentType: 'episode', tmdbId: 100,
    title: 'Show', season: 2 }), null);
  const descriptor = provider('alpha');
  const mapping = normalizeMappingResult(descriptor, media, found('alpha'));
  assert.equal(mapping.contentType, 'episode');
  assert.equal(mapping.seasonNumber, 2);
  assert.equal(mapping.episodeNumber, 3);
  assert.equal(normalizeMappingResult(descriptor, media,
    found('alpha', 'https://source.example.test/')), null);
  assert.equal(normalizeMappingResult(descriptor, media,
    { ...found('alpha'), metadata: { token: 'secret' } }), null);
  assert.equal(normalizeMappingResult(descriptor, media,
    { ...found('alpha'), streamUrl: 'https://media.example.test/' }), null);
  assert.equal(normalizeMappingResult(descriptor, media, found('other')), null);
});

test('registry validates descriptors, rejects duplicates and orders priority deterministically', () => {
  const registry = createMappingRegistry([provider('b'),
    provider('a'), provider('high', async () => [], { priority: 20 }),
    provider('off', async () => [], { enabled: false })]);
  assert.deepEqual(registry.select().map((entry) => entry.id), ['high', 'a', 'b']);
  assert.deepEqual(registry.select(['b']).map((entry) => entry.id), ['b']);
  assert.throws(() => registry.register(provider('a')), { code: 'MAPPING_PROVIDER_DUPLICATE' });
  assert.throws(() => registry.select(['missing']), { code: 'MAPPING_PROVIDER_UNKNOWN' });
  assert.throws(() => createMappingRegistry([provider('bad', async () => [],
    { maxConcurrent: 0 })]), { code: 'MAPPING_PROVIDER_INVALID' });
  assert.throws(() => registry.list().push('x'), TypeError);
});

test('found, miss, priority and stop-when-enough across multiple providers', async () => {
  const calls = [];
  const registry = createMappingRegistry([
    provider('low', async () => { calls.push('low'); return [found('low')]; },
      { priority: 1 }),
    provider('high', async () => { calls.push('high'); return [found('high')]; },
      { priority: 20 }),
    provider('never', async () => { calls.push('never'); return []; },
      { priority: 0 }),
  ]);
  const stores = fakeStores([movie(1), movie(2)]);
  const worker = createBulkMappingWorker({ registry, ...stores });
  const result = await worker.run({ targetMappings: 2, workers: 1 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.progress, { total: 2, processed: 2,
    mapped: 2, no_mapping: 0, skipped: 0, failed: 0, active: 0 });
  assert.deepEqual(calls, ['high', 'low', 'high', 'low']);
  assert.equal(stores.mappings.length, 4);
  assert.equal(new Set(stores.claims).size, 2);
});

test('existing Pluto mappings satisfy target without calling providers', async () => {
  const row = movie(5);
  const key = mediaKey({ contentType: 'movie', tmdbId: 5 });
  const stores = fakeStores([row], [
    { mediaKey: key, provider_id: 'pluto', region: 'latam',
      external_id: 'one', status: 'active' },
    { mediaKey: key, provider_id: 'pluto', region: 'latam',
      external_id: 'two', status: 'active' },
  ]);
  let calls = 0;
  const registry = createMappingRegistry([provider('alpha', async () => {
    calls += 1; return []; })]);
  const result = await createBulkMappingWorker({ registry, ...stores }).run({});
  assert.equal(result.progress.skipped, 1);
  assert.equal(calls, 0);
  assert.equal(stores.mappings.length, 2);
});

test('inactive mapping does not satisfy target and may be reactivated idempotently',
  async () => {
    const key = mediaKey({ contentType: 'movie', tmdbId: 6 });
    const stores = fakeStores([movie(6)], [{ mediaKey: key,
      provider_id: 'alpha', region: 'latam', external_id: 'external-alpha',
      status: 'inactive' }]);
    const registry = createMappingRegistry([provider('alpha', async () =>
      [found('alpha', 'external-alpha')])]);
    const result = await createBulkMappingWorker({ registry, ...stores }).run({
      targetMappings: 1 });
    assert.equal(result.progress.mapped, 1);
    assert.equal(stores.mappings.length, 1);
    assert.equal(stores.mappings[0].status, 'active');
    assert.ok(stores.mappings[0].last_verified_at instanceof Date);
  });

test('miss and provider failure are isolated; later provider can succeed', async () => {
  const stores = fakeStores([movie(1), movie(2)]);
  const registry = createMappingRegistry([
    provider('broken', async () => { throw new Error('secret internal detail'); },
      { priority: 20 }),
    provider('fallback', async (media) => media.tmdbId === 1
      ? [found('fallback')] : [], { priority: 10 }),
  ]);
  const result = await createBulkMappingWorker({ registry, ...stores }).run({
    targetMappings: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(result.progress.mapped, 1);
  assert.equal(result.progress.failed, 1);
  assert.equal(stores.mappings.length, 1);
});

test('movie/episode filtering and disabled provider', async () => {
  const stores = fakeStores([movie(1), episode(2)]);
  const calls = [];
  const registry = createMappingRegistry([
    provider('movie_only', async () => { calls.push('movie'); return []; },
      { supportsSeries: false }),
    provider('series_only', async () => { calls.push('series'); return []; },
      { supportsMovies: false }),
    provider('disabled', async () => { calls.push('disabled'); return []; },
      { enabled: false }),
  ]);
  const result = await createBulkMappingWorker({ registry, ...stores }).run({});
  assert.deepEqual(calls, ['movie', 'series']);
  assert.equal(result.progress.no_mapping, 2);
});

test('dry-run does not create runs, items or mappings and reports each batch', async () => {
  const stores = fakeStores([movie(1), movie(2)]);
  const messages = [];
  const registry = createMappingRegistry([provider('alpha', async () =>
    [found('alpha')])]);
  const result = await createBulkMappingWorker({ registry, ...stores,
    logger: (message) => messages.push(message) }).run({ dryRun: true,
    batchSize: 1, targetMappings: 1 });
  assert.equal(result.runId, null);
  assert.equal(result.progress.mapped, 2);
  assert.equal(stores.runs.size, 0);
  assert.equal(stores.items.size, 0);
  assert.equal(stores.mappings.length, 0);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Processed: 1 \/ 2 \(50\.0%\)/);
});

test('stop then resume same run without double claims or duplicate mappings', async () => {
  const stores = fakeStores([movie(1), movie(2), movie(3)]);
  const registry = createMappingRegistry([provider('alpha', async () =>
    [found('alpha')])]);
  let first;
  first = createBulkMappingWorker({ registry, ...stores,
    logger: () => first.stop() });
  const paused = await first.run({ workers: 1, batchSize: 1,
    targetMappings: 1 });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.progress.processed, 1);
  const resumed = await createBulkMappingWorker({ registry, ...stores }).run({
    resume: paused.runId });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.progress.processed, 3);
  assert.equal(stores.mappings.length, 3);
  assert.equal(new Set(stores.claims).size, 3);
});

test('rerun creates no duplicate mappings and existing active rows skip', async () => {
  const stores = fakeStores([movie(1)]);
  const registry = createMappingRegistry([provider('alpha', async () =>
    [found('alpha')])]);
  const worker = createBulkMappingWorker({ registry, ...stores });
  await worker.run({ targetMappings: 1 });
  const repeat = await worker.run({ targetMappings: 1 });
  assert.equal(repeat.progress.skipped, 1);
  assert.equal(stores.mappings.length, 1);
});

test('failed item can resume and retry without creating a duplicate mapping', async () => {
  const stores = fakeStores([movie(1)]);
  let shouldFail = true;
  const registry = createMappingRegistry([provider('alpha', async () => {
    if (shouldFail) throw new Error('transient');
    return [found('alpha')];
  })]);
  const first = await createBulkMappingWorker({ registry, ...stores }).run({
    targetMappings: 1 });
  assert.equal(first.status, 'failed');
  shouldFail = false;
  const second = await createBulkMappingWorker({ registry, ...stores }).run({
    resume: first.runId });
  assert.equal(second.status, 'completed');
  assert.equal(second.progress.mapped, 1);
  assert.equal(stores.mappings.length, 1);
});

test('provider maxConcurrent and minDelayMs apply across concurrent executions', async () => {
  let active = 0;
  let peak = 0;
  let release;
  const waits = [];
  let clock = 0;
  const registry = createMappingRegistry([provider('limited', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => { release = resolve; });
    active -= 1;
    return [];
  }, { minDelayMs: 50 })], {
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  const entry = registry.get('limited');
  const first = registry.execute(entry, {});
  await Promise.resolve();
  const second = registry.execute(entry, {});
  await Promise.resolve();
  assert.equal(peak, 1);
  release();
  await first;
  await Promise.resolve();
  release();
  await second;
  assert.equal(peak, 1);
  assert.deepEqual(waits, [50]);
});

test('CLI rejects unsafe arguments and progress handles zero elapsed/rate', () => {
  assert.deepEqual(parseArgs(['--limit', '5', '--providers', 'pluto',
    '--target-mappings', '2', '--workers', '2', '--batch-size', '25']),
  { dryRun: false, providers: ['pluto'], limit: 5, targetMappings: 2,
    workers: 2, batchSize: 25 });
  for (const args of [['--workers', '0'], ['--providers', 'a,a'],
    ['--providers', 'BAD'], ['--resume', 'bad'], ['--nope', 'x'],
    ['--dry-run', '--dry-run']]) {
    assert.throws(() => parseArgs(args), { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
  }
  const text = formatMappingProgress({ progress: { total: 10, processed: 0,
    mapped: 0, no_mapping: 0, skipped: 0, failed: 0 }, startedAt: 100, now: 100 });
  assert.match(text, /0\.0 items\/s/);
  assert.match(text, /ETA: --:--:--/);
  assert.deepEqual(createCliRegistry().select().map((entry) => entry.id), ['pluto']);
});

test('PostgreSQL worker persists mappings, uses disjoint claims and preserves IDs',
  { skip: process.env.TEST_DB_URL ? false : 'Set TEST_DB_URL for PostgreSQL integration' },
  async () => {
    const schema = `kanchita_bulk_mapping_${randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
    const db = new Pool({ connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations({ pool: db, logger: { log() {} } });
      const movies = [];
      for (let id = 1; id <= 4; id += 1) {
        const { rows } = await db.query(`INSERT INTO movies (tmdb_id,title)
          VALUES ($1,$2) RETURNING id`, [id, `Movie ${id}`]);
        movies.push(rows[0].id);
      }
      const { rows: seriesRows } = await db.query(`INSERT INTO series
        (tmdb_id,title) VALUES (100,'Series 100') RETURNING id`);
      await db.query(`INSERT INTO episodes
        (series_id,season_number,episode_number,title)
        VALUES ($1,2,3,'Episode')`, [seriesRows[0].id]);
      const bulkStore = createBulkMappingStore(db);
      const runStore = createIngestionRunStore(db);
      const mappingStore = createProviderMediaMappingStore(db);
      const run = await bulkStore.createRunWithItems({ limit: null,
        providers: ['alpha'], targetMappings: 1, workers: 2, batchSize: 1 });
      assert.equal(run.requested_count, 5);
      await runStore.resumeRun(run.id);
      const [left, right] = await Promise.all([
        runStore.claimNextPendingItems(run.id, 1),
        runStore.claimNextPendingItems(run.id, 1),
      ]);
      assert.notEqual(left[0].id, right[0].id);
      const registry = createMappingRegistry([provider('alpha', async (media) =>
        [found('alpha', `${media.contentType}-${media.tmdbId}`)])]);
      const result = await createBulkMappingWorker({ registry, bulkStore,
        runStore, mappingStore }).run({ resume: run.id });
      assert.equal(result.status, 'completed');
      assert.equal(result.progress.mapped, 5);
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS n
        FROM provider_media_mappings`)).rows[0].n, 5);
      const verifiedBefore = (await db.query(`SELECT last_verified_at FROM
        provider_media_mappings WHERE content_type='movie' AND tmdb_id=1`)).rows[0]
        .last_verified_at;
      const rerun = await createBulkMappingWorker({ registry, bulkStore,
        runStore, mappingStore }).run({ targetMappings: 1, workers: 2, batchSize: 2 });
      assert.equal(rerun.progress.skipped, 5);
      await createBulkMappingWorker({ registry, bulkStore, runStore, mappingStore,
        now: () => Date.now() + 60_000 }).run({ targetMappings: 2,
        workers: 2, batchSize: 2 });
      const verifiedAfter = (await db.query(`SELECT last_verified_at FROM
        provider_media_mappings WHERE content_type='movie' AND tmdb_id=1`)).rows[0]
        .last_verified_at;
      assert.ok(verifiedAfter > verifiedBefore);
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS n
        FROM provider_media_mappings`)).rows[0].n, 5);
      assert.deepEqual((await db.query('SELECT id FROM movies ORDER BY tmdb_id')).rows
        .map((row) => row.id), movies);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
