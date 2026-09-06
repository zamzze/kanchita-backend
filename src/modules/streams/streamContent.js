'use strict';

const pool = require('../../config/db');

const findStreamContent = async (contentType, contentId, db = pool) => {
  if (contentType === 'movie') {
    const { rows } = await db.query(
      `SELECT id, tmdb_id, title
       FROM movies
       WHERE id = $1 AND is_published = TRUE`,
      [contentId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT e.id, e.season_number, e.episode_number, e.title,
            s.tmdb_id, s.title AS series_title
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1
       AND e.is_published = TRUE
       AND s.is_published = TRUE`,
    [contentId]
  );
  return rows[0] || null;
};

module.exports = { findStreamContent };
