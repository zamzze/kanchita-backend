'use strict';

const { errorCode, invalid, positiveId, safeJsonObject, uuid } =
  require('./bulkPersistence.validation');

const RUN_TYPES = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOMES = new Set(['completed', 'no_mapping', 'no_source', 'skipped']);

const normalizeRun = (input) => {
  const runType = input?.runType;
  const requestedCount = input?.requestedCount ?? 0;
  const checkpoint = safeJsonObject(input?.checkpoint);
  const config = safeJsonObject(input?.config);
  if (typeof runType !== 'string' || !RUN_TYPES.test(runType) ||
      !Number.isSafeInteger(requestedCount) || requestedCount < 0 ||
      !checkpoint || !config) return null;
  return Object.freeze({ runType, requestedCount, checkpoint, config });
};

const normalizeItemIdentity = (input) => {
  if (!uuid(input?.runId) || !uuid(input?.contentId) ||
      !['movie', 'series', 'episode'].includes(input?.contentType)) return null;
  return Object.freeze({ runId: input.runId,
    movieId: input.contentType === 'movie' ? input.contentId : null,
    seriesId: input.contentType === 'series' ? input.contentId : null,
    episodeId: input.contentType === 'episode' ? input.contentId : null });
};

const counterSql = `UPDATE ingestion_runs SET
  processed_count = (SELECT COUNT(*)::integer FROM ingestion_run_items WHERE run_id = $1
    AND status IN ('completed','no_mapping','no_source','failed','skipped')),
  mapped_count = (SELECT COALESCE(SUM(mapping_count),0)::integer FROM ingestion_run_items
    WHERE run_id = $1 AND status IN ('completed','no_mapping','no_source','failed','skipped')),
  source_count = (SELECT COALESCE(SUM(source_count),0)::integer FROM ingestion_run_items
    WHERE run_id = $1 AND status IN ('completed','no_mapping','no_source','failed','skipped')),
  validated_stream_count = (SELECT COALESCE(SUM(stream_count),0)::integer FROM ingestion_run_items
    WHERE run_id = $1 AND status IN ('completed','no_mapping','no_source','failed','skipped')),
  failed_count = (SELECT COUNT(*)::integer FROM ingestion_run_items WHERE run_id = $1
    AND status = 'failed'),
  checkpoint_json = COALESCE($2::jsonb, checkpoint_json), updated_at = NOW()
  WHERE id = $1 RETURNING *`;

const createIngestionRunStore = (db) => {
  if (!db || typeof db.query !== 'function' || typeof db.connect !== 'function') {
    throw invalid('INGESTION_RUN_INVALID_DB');
  }
  const createRun = async (input) => {
    const run = normalizeRun(input);
    if (!run) throw invalid('INGESTION_RUN_INVALID_INPUT');
    const { rows } = await db.query(`INSERT INTO ingestion_runs
      (run_type, requested_count, checkpoint_json, config_json)
      VALUES ($1,$2,$3::jsonb,$4::jsonb) RETURNING *`,
    [run.runType, run.requestedCount, JSON.stringify(run.checkpoint), JSON.stringify(run.config)]);
    return rows[0];
  };
  const getRun = async (runId) => {
    if (!uuid(runId)) throw invalid('INGESTION_RUN_INVALID_ID');
    const { rows } = await db.query('SELECT * FROM ingestion_runs WHERE id = $1', [runId]);
    return rows[0] || null;
  };
  const updateCounters = async (runId, checkpoint) => {
    if (!uuid(runId)) throw invalid('INGESTION_RUN_INVALID_ID');
    const safe = checkpoint === undefined ? null : safeJsonObject(checkpoint);
    if (checkpoint !== undefined && !safe) throw invalid('INGESTION_RUN_INVALID_CHECKPOINT');
    const { rows } = await db.query(counterSql, [runId, safe && JSON.stringify(safe)]);
    return rows[0] || null;
  };
  const upsertRunItem = async (input) => {
    const identity = normalizeItemIdentity(input);
    if (!identity) throw invalid('INGESTION_ITEM_INVALID_IDENTITY');
    const column = identity.movieId ? 'movie_id' : identity.seriesId
      ? 'series_id' : 'episode_id';
    const contentId = identity.movieId || identity.seriesId || identity.episodeId;
    const { rows } = await db.query(`INSERT INTO ingestion_run_items (run_id, ${column})
      VALUES ($1,$2)
      ON CONFLICT (run_id, ${column}) WHERE ${column} IS NOT NULL DO UPDATE SET
        status = CASE WHEN ingestion_run_items.status = 'failed' THEN 'pending'
          ELSE ingestion_run_items.status END,
        last_error_code = CASE WHEN ingestion_run_items.status = 'failed' THEN NULL
          ELSE ingestion_run_items.last_error_code END,
        finished_at = CASE WHEN ingestion_run_items.status = 'failed' THEN NULL
          ELSE ingestion_run_items.finished_at END,
        updated_at = NOW()
      RETURNING *`, [identity.runId, contentId]);
    return rows[0];
  };
  const claimNextPendingItems = async (runId, limit = 1) => {
    if (!uuid(runId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw invalid('INGESTION_ITEM_INVALID_CLAIM');
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query('SELECT status FROM ingestion_runs WHERE id = $1 FOR SHARE',
        [runId]);
      if (run.rows[0]?.status !== 'running') {
        await client.query('COMMIT');
        return [];
      }
      const { rows } = await client.query(`WITH selected AS (
        SELECT id FROM ingestion_run_items WHERE run_id = $1 AND status = 'pending'
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE ingestion_run_items item SET status = 'processing',
        attempt_count = item.attempt_count + 1, started_at = NOW(), finished_at = NULL,
        updated_at = NOW() FROM selected WHERE item.id = selected.id RETURNING item.*`,
      [runId, limit]);
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  const markItemCompleted = async ({ itemId, status = 'completed', mappingCount = 0,
    sourceCount = 0, streamCount = 0 }) => {
    if (!uuid(itemId) || !OUTCOMES.has(status) ||
        [mappingCount, sourceCount, streamCount].some((count) =>
          !Number.isSafeInteger(count) || count < 0)) throw invalid('INGESTION_ITEM_INVALID_RESULT');
    const { rows } = await db.query(`UPDATE ingestion_run_items SET status = $2,
      mapping_count = $3, source_count = $4, stream_count = $5,
      last_error_code = NULL, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'processing' RETURNING *`,
    [itemId, status, mappingCount, sourceCount, streamCount]);
    return rows[0] || null;
  };
  const markItemFailed = async ({ itemId, code }) => {
    if (!uuid(itemId) || !errorCode(code) || code === null) {
      throw invalid('INGESTION_ITEM_INVALID_FAILURE');
    }
    const { rows } = await db.query(`UPDATE ingestion_run_items SET status = 'failed',
      last_error_code = $2, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'processing' RETURNING *`, [itemId, code]);
    return rows[0] || null;
  };
  const resumeRun = async (runId) => {
    if (!uuid(runId)) throw invalid('INGESTION_RUN_INVALID_ID');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query('SELECT status FROM ingestion_runs WHERE id = $1 FOR UPDATE',
        [runId]);
      if (!run.rows[0] || !['pending', 'paused', 'failed'].includes(run.rows[0].status)) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(`UPDATE ingestion_run_items SET status = 'pending',
        started_at = NULL, updated_at = NOW()
        WHERE run_id = $1 AND status = 'processing'`, [runId]);
      await client.query(`UPDATE ingestion_runs SET status = 'running',
        started_at = COALESCE(started_at, NOW()), finished_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [runId]);
      const { rows } = await client.query(counterSql, [runId, null]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  return Object.freeze({ createRun, getRun, updateCounters, upsertRunItem,
    claimNextPendingItems, markItemCompleted, markItemFailed, resumeRun });
};

module.exports = { createIngestionRunStore, normalizeRun, normalizeItemIdentity };
