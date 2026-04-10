const pool = require('../config/db');

const log = async ({ contentType, contentId, tmdbId, provider, status, streamsFound, errorMessage }) => {
  await pool.query(
    `INSERT INTO scraper_log
       (content_type, content_id, tmdb_id, provider, status, streams_found, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [contentType, contentId, tmdbId, provider || null,
     status, streamsFound || 0, errorMessage || null]
  );
};

const getRecentLogs = async (limit = 50) => {
  const { rows } = await pool.query(
    `SELECT * FROM scraper_log
     ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
};

module.exports = { log, getRecentLogs };