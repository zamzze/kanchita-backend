'use strict';

const { invalid, uuid } = require('./bulkPersistence.validation');

const RUN_TYPE = 'catalog_seed'; // ingestion_runs.run_type uses lowercase identifiers.
const TYPES = Object.freeze(['movie', 'series']);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validCursor = (value) => value && Number.isInteger(value.year) &&
  Number.isInteger(value.page) && value.page >= 1 && value.page <= 500 &&
  Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 20 &&
  typeof value.done === 'boolean';
const emptyStats = () => ({ inserted: 0, updated: 0, unchanged: 0, failed: 0 });
const sameCursor = (a, b) => a && b && a.year === b.year && a.page === b.page &&
  a.offset === b.offset && a.done === b.done;

const movieSql = `INSERT INTO movies (tmdb_id,title,original_title,description,
  release_year,poster_url,backdrop_url,rating,is_published)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
  ON CONFLICT (tmdb_id) DO UPDATE SET
    title = EXCLUDED.title, original_title = EXCLUDED.original_title,
    description = EXCLUDED.description, release_year = EXCLUDED.release_year,
    poster_url = EXCLUDED.poster_url, backdrop_url = EXCLUDED.backdrop_url,
    rating = EXCLUDED.rating, updated_at = NOW()
  WHERE (movies.title,movies.original_title,movies.description,movies.release_year,
    movies.poster_url,movies.backdrop_url,movies.rating) IS DISTINCT FROM
    (EXCLUDED.title,EXCLUDED.original_title,EXCLUDED.description,EXCLUDED.release_year,
    EXCLUDED.poster_url,EXCLUDED.backdrop_url,EXCLUDED.rating)
  RETURNING id,(xmax = 0) AS inserted`;
const seriesSql = `INSERT INTO series (tmdb_id,title,original_title,description,
  release_year,poster_url,backdrop_url,rating,is_published)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
  ON CONFLICT (tmdb_id) DO UPDATE SET
    title = EXCLUDED.title, original_title = EXCLUDED.original_title,
    description = EXCLUDED.description, release_year = EXCLUDED.release_year,
    poster_url = EXCLUDED.poster_url, backdrop_url = EXCLUDED.backdrop_url,
    rating = EXCLUDED.rating, updated_at = NOW()
  WHERE (series.title,series.original_title,series.description,series.release_year,
    series.poster_url,series.backdrop_url,series.rating) IS DISTINCT FROM
    (EXCLUDED.title,EXCLUDED.original_title,EXCLUDED.description,EXCLUDED.release_year,
    EXCLUDED.poster_url,EXCLUDED.backdrop_url,EXCLUDED.rating)
  RETURNING id,(xmax = 0) AS inserted`;

const valuesFor = (type, item) => [item.tmdb_id, item.title, item.original_title,
  item.description, item.release_year, item.poster_url, item.backdrop_url,
  item.rating];

const createCatalogSeedStore = (db) => {
  if (!db || typeof db.query !== 'function' || typeof db.connect !== 'function') {
    throw invalid('CATALOG_SEED_INVALID_DB');
  }
  const catalogCounts = async (client = db) => {
    const { rows } = await client.query(`SELECT
      (SELECT COUNT(*)::integer FROM movies WHERE tmdb_id IS NOT NULL) AS movie,
      (SELECT COUNT(*)::integer FROM series WHERE tmdb_id IS NOT NULL) AS series`);
    return rows[0];
  };
  const createRun = async (config) => {
    if (!config || !isCount(config.targets?.movie) || !isCount(config.targets?.series) ||
        !Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 100 ||
        !Number.isInteger(config.maxPages) || config.maxPages < 1 || config.maxPages > 500 ||
        !Number.isInteger(config.startYear) || config.startYear < 1900 ||
        !Number.isInteger(config.minYear) || config.minYear < 1900 ||
        config.startYear < config.minYear) throw invalid('CATALOG_SEED_INVALID_CONFIG');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const counts = await catalogCounts(client);
      const refreshExisting = TYPES.every((type) => counts[type] >= config.targets[type]);
      const checkpoint = { version: 1,
        cursor: Object.fromEntries(TYPES.map((type) => [type,
          { year: config.startYear, page: 1, offset: 0,
            done: config.targets[type] === 0 ||
              !refreshExisting && counts[type] >= config.targets[type] }])),
        refreshExisting,
        seenTmdbIds: refreshExisting ? { movie: [], series: [] } : null,
        progress: refreshExisting ? { movie: 0, series: 0 } : {
          movie: Math.min(counts.movie, config.targets.movie),
          series: Math.min(counts.series, config.targets.series) },
        stats: emptyStats(), pages: { movie: 0, series: 0 } };
      const { rows } = await client.query(`INSERT INTO ingestion_runs
        (run_type,status,requested_count,processed_count,config_json,checkpoint_json)
        VALUES ($1,'pending',$2,$3,$4::jsonb,$5::jsonb) RETURNING *`,
      [RUN_TYPE, config.targets.movie + config.targets.series,
        checkpoint.progress.movie + checkpoint.progress.series,
        JSON.stringify(config), JSON.stringify(checkpoint)]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const getRun = async (runId) => {
    if (!uuid(runId)) throw invalid('CATALOG_SEED_INVALID_RUN');
    const { rows } = await db.query(`SELECT * FROM ingestion_runs
      WHERE id = $1 AND run_type = $2`, [runId, RUN_TYPE]);
    return rows[0] || null;
  };
  const resumeRun = async (runId) => {
    if (!uuid(runId)) throw invalid('CATALOG_SEED_INVALID_RUN');
    const { rows } = await db.query(`UPDATE ingestion_runs SET status = 'running',
      started_at = COALESCE(started_at,NOW()), finished_at = NULL,
      last_error_code = NULL, updated_at = NOW()
      WHERE id = $1 AND run_type = $2
        AND status IN ('pending','running','paused','failed') RETURNING *`,
    [runId, RUN_TYPE]);
    return rows[0] || null;
  };
  const commitBatch = async ({ runId, type, expectedCursor, nextCursor, items,
    failed = 0, pageFinished = false }) => {
    if (!uuid(runId) || !TYPES.includes(type) || !validCursor(expectedCursor) ||
        !validCursor(nextCursor) || !Array.isArray(items) || items.length > 100 ||
        !isCount(failed) || typeof pageFinished !== 'boolean') {
      throw invalid('CATALOG_SEED_INVALID_BATCH');
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM ingestion_runs
        WHERE id = $1 AND run_type = $2 FOR UPDATE`, [runId, RUN_TYPE]);
      const run = locked.rows[0];
      if (!run || run.status !== 'running' ||
          !sameCursor(run.checkpoint_json?.cursor?.[type], expectedCursor)) {
        throw invalid('CATALOG_SEED_CHECKPOINT_CONFLICT');
      }
      const delta = emptyStats();
      const seen = new Set();
      for (const item of items) {
        if (!Number.isSafeInteger(item?.tmdb_id) || item.tmdb_id < 1 ||
            seen.has(item.tmdb_id)) continue;
        seen.add(item.tmdb_id);
        const { rows } = await client.query(type === 'movie' ? movieSql : seriesSql,
          valuesFor(type, item));
        if (!rows[0]) delta.unchanged += 1;
        else if (rows[0].inserted) delta.inserted += 1;
        else delta.updated += 1;
      }
      delta.failed = failed;
      const counts = await catalogCounts(client);
      const checkpoint = run.checkpoint_json;
      checkpoint.cursor[type] = nextCursor;
      if (checkpoint.refreshExisting) {
        const visited = new Set(checkpoint.seenTmdbIds[type]);
        for (const id of seen) visited.add(id);
        checkpoint.seenTmdbIds[type] = [...visited];
        checkpoint.progress[type] = Math.min(visited.size, run.config_json.targets[type]);
      } else {
        checkpoint.progress[type] = Math.min(counts[type], run.config_json.targets[type]);
      }
      if (checkpoint.progress[type] >= run.config_json.targets[type]) {
        checkpoint.cursor[type].done = true;
      }
      if (pageFinished) checkpoint.pages[type] += 1;
      for (const key of Object.keys(delta)) checkpoint.stats[key] += delta[key];
      const { rows } = await client.query(`UPDATE ingestion_runs SET
        checkpoint_json = $2::jsonb,
        processed_count = $3, failed_count = $4, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [runId, JSON.stringify(checkpoint),
        checkpoint.progress.movie + checkpoint.progress.series, checkpoint.stats.failed]);
      await client.query('COMMIT');
      return Object.freeze({ run: rows[0], delta, counts });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const markFailed = async (runId, code) => {
    if (!uuid(runId) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw invalid('CATALOG_SEED_INVALID_FAILURE');
    }
    const { rows } = await db.query(`UPDATE ingestion_runs SET status = 'failed',
      last_error_code = $2, failed_count = failed_count + 1,
      checkpoint_json = jsonb_set(checkpoint_json, '{stats,failed}',
        to_jsonb(failed_count + 1), TRUE), updated_at = NOW()
      WHERE id = $1 AND run_type = $3 AND status = 'running' RETURNING *`,
    [runId, code, RUN_TYPE]);
    return rows[0] || null;
  };
  const completeRun = async (runId) => {
    if (!uuid(runId)) throw invalid('CATALOG_SEED_INVALID_RUN');
    const { rows } = await db.query(`UPDATE ingestion_runs SET status = 'completed',
      finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND run_type = $2 AND status = 'running'
        AND (checkpoint_json #>> '{cursor,movie,done}')::boolean = TRUE
        AND (checkpoint_json #>> '{cursor,series,done}')::boolean = TRUE
      RETURNING *`, [runId, RUN_TYPE]);
    return rows[0] || null;
  };
  return Object.freeze({ catalogCounts, createRun, getRun, resumeRun, commitBatch,
    markFailed, completeRun });
};

module.exports = { createCatalogSeedStore, RUN_TYPE };
