const pool = require('../config/db');

const upsertMovie = async (movie) => {
  const { rows } = await pool.query(
    `INSERT INTO movies
       (tmdb_id, title, original_title, description, release_year, duration_seconds,
        poster_url, backdrop_url, rating, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       title            = EXCLUDED.title,
       original_title   = EXCLUDED.original_title,
       description      = EXCLUDED.description,
       poster_url       = EXCLUDED.poster_url,
       backdrop_url     = EXCLUDED.backdrop_url,
       duration_seconds = EXCLUDED.duration_seconds,
       updated_at       = NOW()
     RETURNING id, tmdb_id`,
    [movie.tmdb_id, movie.title, movie.original_title, movie.description,
     movie.release_year, movie.duration_seconds, movie.poster_url,
     movie.backdrop_url, movie.rating, movie.is_published]
  );
  return rows[0];
};

const upsertSeries = async (series) => {
  const { rows } = await pool.query(
    `INSERT INTO series
       (tmdb_id, title, description, release_year, poster_url,
        backdrop_url, rating, status, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       title        = EXCLUDED.title,
       description  = EXCLUDED.description,
       poster_url   = EXCLUDED.poster_url,
       backdrop_url = EXCLUDED.backdrop_url,
       status       = EXCLUDED.status,
       updated_at   = NOW()
     RETURNING id, tmdb_id`,
    [series.tmdb_id, series.title, series.description, series.release_year,
     series.poster_url, series.backdrop_url, series.rating,
     series.status, series.is_published]
  );
  return rows[0];
};

const upsertEpisode = async (episode) => {
  const { rows } = await pool.query(
    `INSERT INTO episodes
       (series_id, tmdb_id, season_number, episode_number, title,
        description, duration_seconds, thumbnail_url, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (series_id, season_number, episode_number) DO UPDATE SET
       title            = EXCLUDED.title,
       description      = EXCLUDED.description,
       duration_seconds = EXCLUDED.duration_seconds,
       thumbnail_url    = EXCLUDED.thumbnail_url
     RETURNING id`,
    [episode.series_id, episode.tmdb_id, episode.season_number,
     episode.episode_number, episode.title, episode.description,
     episode.duration_seconds, episode.thumbnail_url, episode.is_published]
  );
  return rows[0];
};

const upsertGenres = async (contentType, contentId, genres) => {
  if (!genres.length) return;
  for (const genre of genres) {
    // Upsert del género
    await pool.query(
      `INSERT INTO genres (id, name, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [genre.id, genre.name, genre.name.toLowerCase().replace(/\s+/g, '-')]
    );
    // Relación contenido-género
    await pool.query(
      `INSERT INTO content_genres (content_type, content_id, genre_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (content_type, content_id, genre_id) DO NOTHING`,
      [contentType, contentId, genre.id]
    );
  }
};

// Reemplaza todos los streams del contenido (borra viejos, inserta nuevos)
const replaceStreams = async (contentType, contentId, streams) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM streams WHERE content_type = $1 AND content_id = $2`,
      [contentType, contentId]
    );
    for (const [i, stream] of streams.entries()) {
      await client.query(
        `INSERT INTO streams
           (content_type, content_id, server_name, quality, language,
            stream_url, embed_url, stream_type, priority, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          stream.content_type, stream.content_id, stream.server_name,
          stream.quality,      stream.language,   stream.stream_url,
          stream.embed_url,    stream.stream_type, i + 1, true,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { upsertMovie, upsertSeries, upsertEpisode, upsertGenres, replaceStreams };