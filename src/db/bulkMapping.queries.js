'use strict';

const { invalid, uuid } = require('./bulkPersistence.validation');
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

const catalogSql = `SELECT content_type, content_id, tmdb_id, title, original_title,
  release_year, season_number, episode_number FROM (
    SELECT 'movie'::text AS content_type, m.id AS content_id, m.tmdb_id,
      m.title, m.original_title, m.release_year,
      NULL::integer AS season_number, NULL::integer AS episode_number
    FROM movies m WHERE m.tmdb_id IS NOT NULL
    UNION ALL
    SELECT 'episode'::text, e.id, s.tmdb_id, s.title, s.original_title,
      s.release_year, e.season_number, e.episode_number
    FROM episodes e JOIN series s ON s.id = e.series_id
    WHERE s.tmdb_id IS NOT NULL
  ) catalog ORDER BY CASE WHEN content_type = 'movie' THEN 0 ELSE 1 END,
    tmdb_id, season_number NULLS FIRST, episode_number NULLS FIRST, content_id`;

const createBulkMappingStore = (db) => {
  if (!db || typeof db.query !== 'function' || typeof db.connect !== 'function') {
    throw invalid('BULK_MAPPING_INVALID_DB');
  }
  const listMedia = async (limit = null) => {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) {
      throw invalid('BULK_MAPPING_INVALID_LIMIT');
    }
    const { rows } = await db.query(`${catalogSql} LIMIT $1::integer`,
      [limit ?? 100_000]);
    return rows;
  };
  const createRunWithItems = async (config) => {
    if (!config || Object.keys(config).some((key) => ![
      'limit', 'providers', 'targetMappings', 'workers', 'batchSize'].includes(key)) ||
        (config.limit !== null &&
          (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 100_000)) ||
        (config.providers !== null && (!Array.isArray(config.providers) ||
          config.providers.some((id) => !PROVIDER_ID.test(id)))) ||
        !Number.isInteger(config.targetMappings) || config.targetMappings < 1 ||
        config.targetMappings > 32 || !Number.isInteger(config.workers) ||
        config.workers < 1 || config.workers > 8 ||
        !Number.isInteger(config.batchSize) || config.batchSize < 1 ||
        config.batchSize > 100) {
      throw invalid('BULK_MAPPING_INVALID_CONFIG');
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(`INSERT INTO ingestion_runs
        (run_type,config_json,checkpoint_json) VALUES
        ('provider_mapping',$1::jsonb,'{}'::jsonb) RETURNING *`, [JSON.stringify(config)]);
      const runId = run.rows[0].id;
      const inserted = await client.query(`INSERT INTO ingestion_run_items
        (run_id,movie_id,episode_id)
        SELECT $1, CASE WHEN content_type = 'movie' THEN content_id END,
          CASE WHEN content_type = 'episode' THEN content_id END
        FROM (${catalogSql} LIMIT $2::integer) selected RETURNING id`,
      [runId, config.limit ?? 100_000]);
      const { rows } = await client.query(`UPDATE ingestion_runs SET
        requested_count=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [runId, inserted.rowCount]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const loadItemMedia = async (runId, itemId) => {
    if (!uuid(runId) || !uuid(itemId)) throw invalid('BULK_MAPPING_INVALID_ITEM');
    const { rows } = await db.query(`SELECT
      CASE WHEN item.movie_id IS NOT NULL THEN 'movie' ELSE 'episode' END AS content_type,
      COALESCE(item.movie_id,item.episode_id) AS content_id,
      COALESCE(movie.tmdb_id, series.tmdb_id) AS tmdb_id,
      COALESCE(movie.title, series.title) AS title,
      COALESCE(movie.original_title, series.original_title) AS original_title,
      COALESCE(movie.release_year, series.release_year) AS release_year,
      episode.season_number, episode.episode_number
      FROM ingestion_run_items item
      LEFT JOIN movies movie ON movie.id=item.movie_id
      LEFT JOIN episodes episode ON episode.id=item.episode_id
      LEFT JOIN series series ON series.id=episode.series_id
      WHERE item.run_id=$1 AND item.id=$2`, [runId, itemId]);
    return rows[0] || null;
  };
  const findActiveMappings = async (media) => {
    if (!media || !['movie', 'episode'].includes(media.contentType) ||
        !Number.isSafeInteger(media.tmdbId) || media.tmdbId < 1) {
      throw invalid('BULK_MAPPING_INVALID_MEDIA');
    }
    const { rows } = await db.query(`SELECT id,provider_id,region,external_id
      FROM provider_media_mappings WHERE status='active'
        AND content_type=$1 AND tmdb_id=$2
        AND season_number IS NOT DISTINCT FROM $3
        AND episode_number IS NOT DISTINCT FROM $4
      ORDER BY id`, [media.contentType, media.tmdbId,
      media.contentType === 'episode' ? media.season : null,
      media.contentType === 'episode' ? media.episode : null]);
    return rows;
  };
  const withRunLock = async (runId, operation) => {
    if (!uuid(runId) || typeof operation !== 'function') {
      throw invalid('BULK_MAPPING_INVALID_RUN');
    }
    const client = await db.connect();
    let locked = false;
    try {
      const { rows } = await client.query(`SELECT
        pg_try_advisory_lock(hashtext('provider_mapping'),hashtext($1)) AS locked`, [runId]);
      locked = rows[0]?.locked === true;
      if (!locked) throw invalid('BULK_MAPPING_RUN_BUSY');
      return await operation();
    } finally {
      try {
        if (locked) await client.query(`SELECT
          pg_advisory_unlock(hashtext('provider_mapping'),hashtext($1))`, [runId]);
      } finally { client.release(); }
    }
  };
  const recoverRunningRun = async (runId) => {
    if (!uuid(runId)) throw invalid('BULK_MAPPING_INVALID_RUN');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM ingestion_runs
        WHERE id=$1 AND run_type='provider_mapping' FOR UPDATE`, [runId]);
      if (rows[0]?.status !== 'running') {
        await client.query('COMMIT');
        return null;
      }
      await client.query(`UPDATE ingestion_run_items SET status='pending',
        started_at=NULL, updated_at=NOW()
        WHERE run_id=$1 AND status='processing'`, [runId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const requeueFailed = async (runId) => {
    if (!uuid(runId)) throw invalid('BULK_MAPPING_INVALID_RUN');
    await db.query(`UPDATE ingestion_run_items SET status='pending',
      last_error_code=NULL, finished_at=NULL, updated_at=NOW()
      WHERE run_id=$1 AND status='failed'`, [runId]);
  };
  const progress = async (runId) => {
    if (!uuid(runId)) throw invalid('BULK_MAPPING_INVALID_RUN');
    const { rows } = await db.query(`SELECT
      COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE status IN
        ('completed','no_mapping','failed','skipped'))::integer AS processed,
      COUNT(*) FILTER (WHERE status='completed')::integer AS mapped,
      COUNT(*) FILTER (WHERE status='no_mapping')::integer AS no_mapping,
      COUNT(*) FILTER (WHERE status='skipped')::integer AS skipped,
      COUNT(*) FILTER (WHERE status='failed')::integer AS failed,
      COUNT(*) FILTER (WHERE status IN ('pending','processing'))::integer AS active
      FROM ingestion_run_items WHERE run_id=$1`, [runId]);
    return rows[0];
  };
  const finishRun = async (runId) => {
    if (!uuid(runId)) throw invalid('BULK_MAPPING_INVALID_RUN');
    const { rows } = await db.query(`UPDATE ingestion_runs SET
      status=CASE WHEN EXISTS (SELECT 1 FROM ingestion_run_items
        WHERE run_id=$1 AND status='failed') THEN 'failed' ELSE 'completed' END,
      finished_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND run_type='provider_mapping' AND status='running'
        AND NOT EXISTS (SELECT 1 FROM ingestion_run_items
          WHERE run_id=$1 AND status IN ('pending','processing')) RETURNING *`, [runId]);
    return rows[0] || null;
  };
  const pauseRun = async (runId) => {
    if (!uuid(runId)) throw invalid('BULK_MAPPING_INVALID_RUN');
    const { rows } = await db.query(`UPDATE ingestion_runs SET status='paused',updated_at=NOW()
      WHERE id=$1 AND run_type='provider_mapping' AND status='running' RETURNING *`, [runId]);
    return rows[0] || null;
  };
  return Object.freeze({ listMedia, createRunWithItems, loadItemMedia,
    findActiveMappings, withRunLock, recoverRunningRun, requeueFailed,
    progress, finishRun, pauseRun });
};

module.exports = { createBulkMappingStore };
