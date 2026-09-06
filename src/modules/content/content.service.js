const pool        = require('../../config/db');
const tmdbFetcher = require('../../ingestion/tmdb/tmdbFetcher');
const {
  normalizeMovie,
  normalizeSeries,
} = require('../../ingestion/normalizer/movieNormalizer');
const { processSeries } = require('../../ingestion/ingestionService');
const { createResolutionQueue } = require('../streams/resolutionQueue');
const db = require('../../db/ingestion.queries');
const { redactSensitive } = require('../../utils/redact');
const resolutionQueue = createResolutionQueue(pool);

const searchAndFetch = async (query, contentType = 'movie') => {
  const endpoint = contentType === 'movie' ? '/search/movie' : '/search/tv';
  const results  = await tmdbFetcher.search(endpoint, query);

  if (!results.length) return [];

  const enriched = await Promise.all(
    results.slice(0, 5).map(async (item) => {
      const table    = contentType === 'movie' ? 'movies' : 'series';
      const { rows } = await pool.query(
        `SELECT id FROM ${table} WHERE tmdb_id = $1`,
        [item.id]
      );

      return {
        tmdb_id:      item.id,
        title:        item.title || item.name,
        release_year: item.release_date
          ? parseInt(item.release_date.slice(0, 4))
          : null,
        poster_url:   item.poster_path
          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
          : null,
        in_catalog:   !!rows[0],
        local_id:     rows[0]?.id || null,
      };
    })
  );

  return enriched;
};

const getOrFetchContent = async (tmdbId, contentType = 'movie') => {
  const table    = contentType === 'movie' ? 'movies' : 'series';
  const { rows } = await pool.query(
    `SELECT id, tmdb_id, title, description, release_year,
            poster_url, backdrop_url, rating
     FROM ${table} WHERE tmdb_id = $1`,
    [tmdbId]
  );

  let content   = rows[0] || null;
  let justAdded = false;

  if (!content) {
    const tmdbData   = contentType === 'movie'
      ? await tmdbFetcher.getMovieDetail(tmdbId)
      : await tmdbFetcher.getSeriesDetail(tmdbId);

    const normalized = contentType === 'movie'
      ? normalizeMovie(tmdbData)
      : normalizeSeries(tmdbData);

    const saved = contentType === 'movie'
      ? await db.upsertMovie(normalized)
      : await db.upsertSeries(normalized);

    await db.upsertGenres(contentType, saved.id, normalized.genres);
    content   = { ...normalized, id: saved.id };
    justAdded = true;
  }

  // Buscar streams existentes
  const { rows: streams } = await pool.query(
    `SELECT server_name, quality, language, stream_url, priority
     FROM streams
     WHERE content_type = $1 AND content_id = $2 AND is_active = TRUE
     ORDER BY priority ASC`,
    [contentType, content.id]
  );

  // Preparar contenido si es nuevo o todavía no tiene streams.
  const needsPreparation = justAdded || streams.length === 0;
  if (needsPreparation) {
    triggerContentPreparation(
      tmdbId,
      content.id,
      contentType,
      content.title,
      content.release_year
    );
  }

  return {
    ...content,
    streams,
    streams_status: streams.length ? 'available' : 'processing',
  };
};

// Fire and forget: las películas sólo encolan resolución; las series importan
// metadata/episodios y dejan el stream de cada episodio para acceso lazy.
const triggerContentPreparation = (tmdbId, contentId, contentType, title, year) => {
  console.log(`[OnDemand] Preparing "${title}" (tmdb:${tmdbId})`);

  const task = contentType === 'movie'
    ? resolutionQueue.enqueue('movie', contentId)
    : processSeries({ id: tmdbId });

  task.catch(err => {
    console.error(
      `[OnDemand] Content preparation failed for tmdb:${tmdbId}`,
      redactSensitive(err.message)
    );
  });
};

module.exports = { searchAndFetch, getOrFetchContent };
