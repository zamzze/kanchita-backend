const pool = require('../config/db');

const findAll = async ({ limit = 20, offset = 0, genre_id } = {}, db = pool) => {
  const params = [limit, offset];
  let genreJoin = '', genreWhere = '';

  if (genre_id) {
    params.push(genre_id);
    genreJoin  = `JOIN content_genres cg ON cg.content_id = s.id AND cg.content_type = 'series'`;
    genreWhere = `AND cg.genre_id = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT s.id, s.title, s.release_year, s.poster_url,
            s.backdrop_url, s.rating, s.status
     FROM series s ${genreJoin}
     WHERE s.is_published = TRUE ${genreWhere}
     ORDER BY s.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return rows;
};

const findById = async (id, db = pool) => {
  const { rows } = await db.query(
    `SELECT s.*,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', g.id, 'name', g.name))
              FILTER (WHERE g.id IS NOT NULL), '[]'
            ) AS genres
     FROM series s
     LEFT JOIN content_genres cg ON cg.content_id = s.id AND cg.content_type = 'series'
     LEFT JOIN genres g ON g.id = cg.genre_id
     WHERE s.id = $1 AND s.is_published = TRUE
     GROUP BY s.id`,
    [id]
  );
  return rows[0] || null;
};

const findSeasons = async (seriesId, db = pool) => {
  const { rows } = await db.query(
    `SELECT DISTINCT season_number,
            COUNT(*) OVER (PARTITION BY season_number) AS episode_count
     FROM episodes
     WHERE series_id = $1 AND is_published = TRUE
     ORDER BY season_number`,
    [seriesId]
  );
  return rows;
};

const findEpisodes = async (seriesId, seasonNumber, db = pool) => {
  const { rows } = await db.query(
    `SELECT id, episode_number, title, description,
            duration_seconds, thumbnail_url
     FROM episodes
     WHERE series_id = $1 AND season_number = $2 AND is_published = TRUE
     ORDER BY episode_number`,
    [seriesId, seasonNumber]
  );
  return rows;
};

const findEpisodeById = async (episodeId, db = pool) => {
  const { rows } = await db.query(
    `SELECT e.id, e.series_id, e.tmdb_id, e.season_number, e.episode_number,
            e.title, e.description, e.duration_seconds, e.thumbnail_url,
            s.tmdb_id AS series_tmdb_id, s.title AS series_title,
            s.poster_url AS series_poster_url,
            s.backdrop_url AS series_backdrop_url
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1 AND e.is_published = TRUE AND s.is_published = TRUE`,
    [episodeId]
  );
  return rows[0] || null;
};

const countAll = async (genre_id, db = pool) => {
  const params = [];
  let genreJoin = '', genreWhere = '';
  if (genre_id) {
    params.push(genre_id);
    genreJoin  = `JOIN content_genres cg ON cg.content_id = s.id AND cg.content_type = 'series'`;
    genreWhere = `AND cg.genre_id = $1`;
  }
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total FROM series s ${genreJoin}
     WHERE s.is_published = TRUE ${genreWhere}`,
    params
  );
  return parseInt(rows[0].total, 10);
};

module.exports = {
  findAll,
  findById,
  findSeasons,
  findEpisodes,
  findEpisodeById,
  countAll,
};
