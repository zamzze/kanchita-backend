'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { normalizeSource, createProviderSourceStore } =
  require('../src/db/providerSources.queries');
const { normalizeStream, createResolvedStreamStore } =
  require('../src/db/resolvedStreamCache.queries');
const { normalizeRun, normalizeItemIdentity, createIngestionRunStore } =
  require('../src/db/ingestionRuns.queries');

const sourceId = crypto.randomUUID();
const runId = crypto.randomUUID();
const contentId = crypto.randomUUID();
const sourceInput = { mappingId: 1, sourceType: 'embed',
  sourceUrl: 'https://source.example.test/watch?id=1', resolverId: 'direct_hls',
  metadata: { origin: 'fixture' } };
const streamInput = { sourceId, protocol: 'hls', variantKey: 'main',
  url: 'https://media.example.test/master.m3u8?token=redacted',
  urlSensitivity: 'temporary_signed',
  expiresAt: new Date(Date.now() + 3_600_000), validatedAt: new Date() };

test('source normalization uses a stable mapping-scoped identity and safe fields', () => {
  const one = normalizeSource(sourceInput);
  assert.ok(one);
  assert.equal(one.sourceKey, normalizeSource({ ...sourceInput }).sourceKey);
  assert.notEqual(one.sourceKey, normalizeSource({ ...sourceInput,
    sourceUrl: 'https://source.example.test/watch?id=2' }).sourceKey);
  assert.equal(one.sourceKey.length, 64);
  assert.equal(normalizeSource({ ...sourceInput,
    sourceUrl: 'https://source.example.test/watch?token=secret' }), null);
  assert.equal(normalizeSource({ ...sourceInput, headers: { Cookie: 'secret' } }), null);
  assert.equal(normalizeSource({ ...sourceInput, metadata: { sessionToken: 'secret' } }), null);
  assert.equal(normalizeSource({ ...sourceInput, metadata: { nested: { url: 'https://x.test/' } } }), null);
  assert.equal(normalizeSource({ ...sourceInput, metadata: JSON.parse('{"__proto__":1}') }), null);
  assert.equal(normalizeSource({ ...sourceInput, sourceType: 'unknown' }), null);
});

test('stream normalization distinguishes identity from rotating signed URL', () => {
  const one = normalizeStream(streamInput);
  assert.ok(one);
  const rotated = normalizeStream({ ...streamInput,
    url: 'https://media.example.test/master.m3u8?token=another' });
  assert.equal(one.streamKey, rotated.streamKey);
  assert.notEqual(one.streamKey, normalizeStream({ ...streamInput,
    variantKey: 'backup' }).streamKey);
  assert.equal(normalizeStream({ ...streamInput, expiresAt: null }), null);
  assert.equal(normalizeStream({ ...streamInput, urlSensitivity: 'normal' }), null);
  assert.equal(normalizeStream({ ...streamInput, headers: { Authorization: 'x' } }), null);
  assert.equal(normalizeStream({ ...streamInput, metadata: { jwt: 'x' } }), null);
  assert.equal(normalizeStream({ ...streamInput, status: 'permanent' }), null);
});

test('run and item identities reject unsafe state without importing a DB pool', () => {
  assert.ok(normalizeRun({ runType: 'catalog_batch', requestedCount: 20_000,
    checkpoint: { cursor: 12 } }));
  assert.equal(normalizeRun({ runType: 'catalog_batch', config: { apiKey: 'secret' } }), null);
  assert.equal(normalizeRun({ runType: 'catalog_batch', requestedCount: -1 }), null);
  assert.deepEqual(normalizeItemIdentity({ runId, contentType: 'movie', contentId }),
    { runId, movieId: contentId, seriesId: null, episodeId: null });
  assert.deepEqual(normalizeItemIdentity({ runId, contentType: 'episode', contentId }),
    { runId, movieId: null, seriesId: null, episodeId: contentId });
  assert.deepEqual(normalizeItemIdentity({ runId, contentType: 'series', contentId }),
    { runId, movieId: null, seriesId: contentId, episodeId: null });
  for (const file of ['providerSources.queries.js', 'resolvedStreamCache.queries.js',
    'ingestionRuns.queries.js']) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', file), 'utf8');
    assert.doesNotMatch(content, /require\(['"]\.\.\/config\/db['"]\)/);
  }
});

test('stores reject malformed input before any SQL and use parameterized idempotent upserts',
  async () => {
    const calls = [];
    const db = { query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ id: sourceId }] };
    }, connect: async () => { throw new Error('unexpected connection'); } };
    const sources = createProviderSourceStore(db);
    const streams = createResolvedStreamStore(db);
    const runs = createIngestionRunStore(db);
    await assert.rejects(sources.upsertSource({ ...sourceInput, headers: { Cookie: 'x' } }),
      { code: 'PROVIDER_SOURCE_INVALID_INPUT' });
    await assert.rejects(streams.upsertStream({ ...streamInput, expiresAt: null }),
      { code: 'RESOLVED_STREAM_INVALID_INPUT' });
    await assert.rejects(runs.createRun({ runType: 'bad', config: { token: 'x' } }),
      { code: 'INGESTION_RUN_INVALID_INPUT' });
    assert.equal(calls.length, 0);
    await sources.upsertSource(sourceInput);
    await streams.upsertStream(streamInput);
    await runs.upsertRunItem({ runId, contentType: 'movie', contentId });
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /ON CONFLICT \(mapping_id, source_key\)/);
    assert.match(calls[1].sql, /ON CONFLICT \(source_id, stream_key\)/);
    assert.match(calls[2].sql, /ON CONFLICT \(run_id, movie_id\)/);
    assert.ok(calls.every(({ values }) => Array.isArray(values)));
    assert.ok(!JSON.stringify(calls.map(({ sql }) => sql)).includes('redacted'));
  });

test('usable cache requires active source, fresh validation and unexpired URL', async () => {
  let query;
  const db = { query: async (sql, values) => {
    query = { sql, values };
    return { rows: [] };
  } };
  const store = createResolvedStreamStore(db);
  assert.deepEqual(await store.findUsableStreamsForSource(sourceId), []);
  assert.match(query.sql, /source\.status = 'active'/);
  assert.match(query.sql, /cache\.validated_at > NOW\(\)/);
  assert.match(query.sql, /cache\.expires_at > NOW\(\)/);
  assert.deepEqual(query.values, [sourceId, 60, 30]);
  await assert.rejects(store.findUsableStreamsForSource(sourceId, -1),
    { code: 'RESOLVED_STREAM_INVALID_LOOKUP' });
});

test('counter reconciliation is derived from terminal items and checkpoint is optional',
  async () => {
    let query;
    const db = { query: async (sql, values) => {
      query = { sql, values };
      return { rows: [{}] };
    }, connect: async () => { throw new Error('unexpected connection'); } };
    const store = createIngestionRunStore(db);
    await store.updateCounters(runId, { offset: 100 });
    assert.match(query.sql, /COUNT\(\*\)::integer/);
    assert.match(query.sql, /SUM\(stream_count\)/);
    assert.deepEqual(query.values, [runId, '{"offset":100}']);
    await assert.rejects(store.updateCounters(runId, { secret: 'x' }),
      { code: 'INGESTION_RUN_INVALID_CHECKPOINT' });
    await assert.rejects(store.markItemCompleted({ itemId: contentId,
      status: 'processing' }), { code: 'INGESTION_ITEM_INVALID_RESULT' });
    await assert.rejects(store.markItemFailed({ itemId: contentId,
      code: 'error with raw URL' }), { code: 'INGESTION_ITEM_INVALID_FAILURE' });
  });

test('claim SQL is transactional and uses FOR UPDATE SKIP LOCKED', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    return { rows: sql.includes('SELECT status') ? [{ status: 'running' }] : [] };
  }, release() { calls.push('RELEASE'); } };
  const db = { query: async () => ({ rows: [] }), connect: async () => client };
  await createIngestionRunStore(db).claimNextPendingItems(runId, 2);
  assert.deepEqual(calls[0], 'BEGIN');
  assert.ok(calls.some((sql) => sql.includes('FOR UPDATE SKIP LOCKED')));
  assert.ok(calls.some((sql) => sql === 'COMMIT'));
  assert.equal(calls.at(-1), 'RELEASE');
});

test('PostgreSQL bulk persistence and restart semantics',
  { skip: process.env.TEST_DB_URL ? false : 'Set TEST_DB_URL for PostgreSQL integration' },
  async () => {
    const schema = `kanchita_bulk_${crypto.randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
    const db = new Pool({ connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations({ pool: db, logger: { log() {} } });
      const mappings = createProviderMediaMappingStore(db);
      const mappingInput = { providerId: 'fixture', region: 'global', contentType: 'movie',
        tmdbId: 550, externalId: 'item-123' };
      const mapping = await mappings.upsertMapping(mappingInput);
      assert.equal((await mappings.upsertMapping(mappingInput)).id, mapping.id);
      const mappingId = Number(mapping.id);
      const sources = createProviderSourceStore(db);
      const streams = createResolvedStreamStore(db);
      const runs = createIngestionRunStore(db);
      const a = await sources.upsertSource({ ...sourceInput, mappingId });
      const b = await sources.upsertSource({ ...sourceInput, mappingId });
      assert.equal(a.id, b.id);
      assert.equal((await sources.findActiveSourcesForMapping(mappingId)).length, 1);
      const first = await streams.upsertStream({ ...streamInput, sourceId: a.id });
      const second = await streams.upsertStream({ ...streamInput, sourceId: a.id,
        url: 'https://media.example.test/master.m3u8?token=rotated' });
      assert.equal(first.id, second.id);
      assert.notEqual(first.stream_url, second.stream_url);
      assert.equal((await streams.findUsableStreamsForSource(a.id)).length, 1);
      await streams.markStreamStatus({ streamId: first.id, status: 'expired' });
      assert.equal((await streams.findUsableStreamsForSource(a.id)).length, 0);
      const expired = await db.query('SELECT stream_url FROM resolved_stream_cache WHERE id = $1',
        [first.id]);
      assert.equal(expired.rows[0].stream_url, null);
      const indexes = await db.query(`SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename IN
        ('provider_sources','resolved_stream_cache','ingestion_runs','ingestion_run_items')`);
      const names = indexes.rows.map((row) => row.indexname);
      assert.ok(names.includes('provider_sources_active_idx'));
      assert.ok(names.includes('resolved_stream_cache_usable_idx'));
      assert.ok(names.includes('ingestion_run_items_claim_idx'));
      assert.ok(names.includes('ingestion_run_items_series_unique'));
      const movie = await db.query(`INSERT INTO movies (tmdb_id,title)
        VALUES (550,'Fixture') RETURNING id`);
      const run = await runs.createRun({ runType: 'catalog_batch', requestedCount: 1 });
      const itemInput = { runId: run.id, contentType: 'movie', contentId: movie.rows[0].id };
      const item = await runs.upsertRunItem(itemInput);
      assert.equal((await runs.upsertRunItem(itemInput)).id, item.id);
      await runs.resumeRun(run.id);
      const [claimA, claimB] = await Promise.all([
        runs.claimNextPendingItems(run.id), runs.claimNextPendingItems(run.id),
      ]);
      assert.equal(claimA.length + claimB.length, 1);
      await db.query("UPDATE ingestion_runs SET status = 'paused' WHERE id = $1", [run.id]);
      await runs.resumeRun(run.id);
      assert.equal((await runs.claimNextPendingItems(run.id)).length, 1);
      await runs.markItemFailed({ itemId: item.id, code: 'RESOLUTION_FAILED' });
      assert.equal((await runs.updateCounters(run.id)).failed_count, 1);
      const retry = await runs.upsertRunItem(itemInput);
      assert.equal(retry.id, item.id);
      assert.equal(retry.status, 'pending');
      assert.equal((await runs.claimNextPendingItems(run.id)).length, 1);
      await runs.markItemCompleted({ itemId: item.id, mappingCount: 1,
        sourceCount: 1, streamCount: 1 });
      const totals = await runs.updateCounters(run.id, { lastProcessedId: item.id });
      assert.equal(totals.processed_count, 1);
      assert.equal(totals.mapped_count, 1);
      assert.equal(totals.failed_count, 0);
      assert.equal(totals.checkpoint_json.lastProcessedId, item.id);
      const show = await db.query(`INSERT INTO series (tmdb_id,title)
        VALUES (42,'Fixture show') RETURNING id`);
      const seriesRun = await runs.createRun({ runType: 'provider_mapping', requestedCount: 1 });
      const seriesItemInput = { runId: seriesRun.id, contentType: 'series',
        contentId: show.rows[0].id };
      const seriesItem = await runs.upsertRunItem(seriesItemInput);
      assert.equal((await runs.upsertRunItem(seriesItemInput)).id, seriesItem.id);
      await assert.rejects(db.query(`INSERT INTO ingestion_run_items
        (run_id,movie_id,series_id) VALUES ($1,$2,$3)`,
      [seriesRun.id, movie.rows[0].id, show.rows[0].id]),
      (error) => error.code === '23514');
      const migrations = await db.query(`SELECT version FROM schema_migrations
        WHERE version = '010_bulk_ingestion_persistence.sql'`);
      assert.equal(migrations.rowCount, 1);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
