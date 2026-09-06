'use strict';

const pool = require('../../config/db');

const createStreamPrewarm = ({
  db = pool,
  queue,
  lifecycle,
  batchSize = 10,
  refreshAheadMinutes = 10,
} = {}) => {
  const enqueueIfNeeded = async (contentType, contentId, priority, jobType = 'resolve') => {
    const cache = await lifecycle.readUsableCache(contentType, contentId);
    if (cache.backoff) return { status: 'backoff' };
    if (cache.streams && jobType !== 'refresh') return { status: 'ready' };
    const job = await queue.enqueue(contentType, contentId, { priority, jobType });
    return { status: 'queued', job };
  };

  const prepareNextEpisode = async (episodeId) => {
    const { rows } = await db.query(
      `SELECT next_episode.id
       FROM episodes current_episode
       JOIN episodes next_episode
         ON next_episode.series_id = current_episode.series_id
        AND (next_episode.season_number, next_episode.episode_number) >
            (current_episode.season_number, current_episode.episode_number)
       JOIN series ON series.id = next_episode.series_id
       WHERE current_episode.id = $1
         AND next_episode.is_published = TRUE
         AND series.is_published = TRUE
       ORDER BY next_episode.season_number, next_episode.episode_number
       LIMIT 1`,
      [episodeId]
    );
    if (!rows[0]) return null;
    return enqueueIfNeeded('episode', rows[0].id, 90);
  };

  const runBatch = async () => {
    const { rows } = await db.query(
      `WITH candidates AS (
         SELECT content_type, content_id, 80 AS priority, 'refresh'::text AS job_type,
                expires_at AS activity_at
         FROM streams
         WHERE is_active = TRUE AND status = 'ready'
           AND expires_at > NOW()
           AND expires_at <= NOW() + ($2::double precision * INTERVAL '1 minute')
         UNION ALL
         SELECT content_type, content_id,
                CASE WHEN request_count >= 10 THEN 70 ELSE 50 END,
                'resolve'::text,
                last_requested_at
         FROM stream_content_stats
         WHERE last_requested_at > NOW() - INTERVAL '7 days'
       )
       , deduplicated AS (
         SELECT DISTINCT ON (content_type, content_id)
           content_type, content_id, priority, job_type, activity_at
         FROM candidates
         ORDER BY content_type, content_id, priority DESC, activity_at DESC
       )
       SELECT content_type, content_id, priority, job_type
       FROM deduplicated
       ORDER BY priority DESC, activity_at DESC
       LIMIT $1`,
      [batchSize, refreshAheadMinutes]
    );
    const results = [];
    for (const row of rows) {
      results.push(await enqueueIfNeeded(
        row.content_type,
        row.content_id,
        row.priority,
        row.job_type
      ));
    }
    return results;
  };

  return { enqueueIfNeeded, prepareNextEpisode, runBatch };
};

module.exports = { createStreamPrewarm };
