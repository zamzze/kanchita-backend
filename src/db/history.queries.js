const pool = require('../config/db');

const upsertProgress = async ({ userId, contentType, contentId, progressSeconds, durationSeconds }) => {
  const { rows } = await pool.query(
    `INSERT INTO watch_history
       (user_id, content_type, content_id, progress_seconds, duration_seconds,
        completed, last_watched_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, content_type, content_id)
     DO UPDATE SET
       progress_seconds = $4,
       duration_seconds = COALESCE($5, watch_history.duration_seconds),
       completed        = $6,
       last_watched_at  = NOW()
     RETURNING *`,
    [
      userId, contentType, contentId,
      progressSeconds, durationSeconds,
      durationSeconds ? progressSeconds >= durationSeconds * 0.9 : false,
    ]
  );
  return rows[0];
};

const findByUser = async (userId, { limit = 20, offset = 0 } = {}) => {
  const { rows } = await pool.query(
    `SELECT wh.content_type, wh.content_id, wh.progress_seconds,
            wh.duration_seconds, wh.completed, wh.last_watched_at,
            CASE wh.content_type
              WHEN 'movie'   THEN m.title
              WHEN 'episode' THEN e.title
            END AS title,
            CASE wh.content_type
              WHEN 'movie'   THEN m.poster_url
              WHEN 'episode' THEN e.thumbnail_url
            END AS thumbnail
     FROM watch_history wh
     LEFT JOIN movies   m ON wh.content_type = 'movie'   AND m.id = wh.content_id
     LEFT JOIN episodes e ON wh.content_type = 'episode' AND e.id = wh.content_id
     WHERE wh.user_id = $1
     ORDER BY wh.last_watched_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
};

const findOne = async (userId, contentType, contentId) => {
  const { rows } = await pool.query(
    `SELECT progress_seconds, duration_seconds, completed
     FROM watch_history
     WHERE user_id = $1 AND content_type = $2 AND content_id = $3`,
    [userId, contentType, contentId]
  );
  return rows[0] || null;
};

module.exports = { upsertProgress, findByUser, findOne };