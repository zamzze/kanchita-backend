const pool = require('../config/db');

const findAll = async ({ limit = 20, offset = 0, genre_id } = {}) => {
  const params = [limit, offset];
  let genreJoin  = '';
  let genreWhere = '';

  if (genre_id) {
    params.push(genre_id);
    genreJoin  = `JOIN content_genres cg ON cg.content_id = m.id AND cg.content_type = 'movie'`;
    genreWhere = `AND cg.genre_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT m.id, m.tmdb_id, m.title, m.release_year, m.duration_seconds,
            m.poster_url, m.backdrop_url, m.rating,
            EXISTS (
              SELECT 1
              FROM streams s
              WHERE s.content_type = 'movie'
                AND s.content_id = m.id
                AND s.is_active = TRUE
                AND s.status = 'ready'
                AND s.stream_url IS NOT NULL
            ) AS playback_ready,
            (
              SELECT COUNT(*)::int
              FROM source_catalog_items sci
              JOIN source_catalog_servers scs
                ON scs.catalog_item_id = sci.id
               AND scs.is_active = TRUE
              WHERE sci.fetch_status = 'ok'
                AND sci.match_status = 'matched'
                AND sci.mapped_content_type = 'movie'
                AND sci.mapped_content_id = m.id
            ) AS catalog_source_count
     FROM movies m
     ${genreJoin}
     WHERE m.is_published = TRUE ${genreWhere}
     ORDER BY m.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return rows;
};

const findById = async (id) => {
  const { rows } = await pool.query(
    `SELECT m.*,
            m.original_title,
            EXISTS (
              SELECT 1
              FROM streams s
              WHERE s.content_type = 'movie'
                AND s.content_id = m.id
                AND s.is_active = TRUE
                AND s.status = 'ready'
                AND s.stream_url IS NOT NULL
            ) AS playback_ready,
            (
              SELECT COUNT(*)::int
              FROM source_catalog_items sci
              JOIN source_catalog_servers scs
                ON scs.catalog_item_id = sci.id
               AND scs.is_active = TRUE
              WHERE sci.fetch_status = 'ok'
                AND sci.match_status = 'matched'
                AND sci.mapped_content_type = 'movie'
                AND sci.mapped_content_id = m.id
            ) AS catalog_source_count,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', g.id, 'name', g.name))
              FILTER (WHERE g.id IS NOT NULL), '[]'
            ) AS genres
     FROM movies m
     LEFT JOIN content_genres cg ON cg.content_id = m.id AND cg.content_type = 'movie'
     LEFT JOIN genres g ON g.id = cg.genre_id
     WHERE m.id = $1 AND m.is_published = TRUE
     GROUP BY m.id`,
    [id]
  );
  return rows[0] || null;
};

const countAll = async (genre_id) => {
  const params = [];
  let genreJoin  = '';
  let genreWhere = '';

  if (genre_id) {
    params.push(genre_id);
    genreJoin  = `JOIN content_genres cg ON cg.content_id = m.id AND cg.content_type = 'movie'`;
    genreWhere = `AND cg.genre_id = $1`;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total FROM movies m ${genreJoin}
     WHERE m.is_published = TRUE ${genreWhere}`,
    params
  );
  return parseInt(rows[0].total, 10);
};

const findAllGenres = async () => {
  const { rows } = await pool.query(
    `SELECT id, name, slug FROM genres ORDER BY name ASC`
  );
  return rows;
};

module.exports = { findAll, findById, countAll, findAllGenres };