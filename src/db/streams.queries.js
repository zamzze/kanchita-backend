const pool = require('../config/db');

const findStreams = async (contentType, contentId) => {
  const { rows } = await pool.query(
    `SELECT id, server_name, quality, language, stream_url, embed_url,
            stream_type, priority, is_active
     FROM streams
     WHERE content_type = $1 AND content_id = $2 AND is_active = TRUE
     ORDER BY priority ASC`,
    [contentType, contentId]
  );
  return rows;
};

const findEpisodeWithSeries = async (episodeId) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.series_id, e.is_published, s.is_published AS series_published
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1`,
    [episodeId]
  );
  return rows[0] || null;
};

const upsertStream = async (stream) => {
  const { rows } = await pool.query(
    `INSERT INTO streams (
        content_type, content_id, server_name, quality, language,
        stream_url, embed_url, stream_type, priority, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
     ON CONFLICT (content_type, content_id, server_name)
     DO UPDATE SET
        stream_url  = EXCLUDED.stream_url,
        embed_url   = EXCLUDED.embed_url,
        stream_type = EXCLUDED.stream_type,
        quality     = EXCLUDED.quality,
        language    = EXCLUDED.language,
        priority    = EXCLUDED.priority,
        is_active   = TRUE
     RETURNING id`,
    [
      stream.content_type,
      stream.content_id,
      stream.server_name,
      stream.quality,
      stream.language,
      stream.stream_url  || null,
      stream.embed_url   || null,
      stream.stream_type,
      stream.priority,
    ]
  );
  return rows[0];
};

const getStreamsByContent = async (contentType, contentId) => {
  return findStreams(contentType, contentId);
};

module.exports = { findStreams, findEpisodeWithSeries, upsertStream, getStreamsByContent };