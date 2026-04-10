const pool        = require('../../config/db');
const tmdbFetcher = require('../../ingestion/tmdb/tmdbFetcher');
const {
  normalizeMovie,
  normalizeSeries,
} = require('../../ingestion/normalizer/movieNormalizer');
const { processMovie, processSeries } = require('../../ingestion/ingestionService');
const db = require('../../db/ingestion.queries');

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

  // Disparar scraper si es nuevo O si ya existe pero no tiene streams
  const needsScraping = justAdded || streams.length === 0;
  if (needsScraping) {
    triggerScraping(
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

// Fire and forget — lanza el scraper sin bloquear la respuesta
const triggerScraping = (tmdbId, contentId, contentType, title, year) => {
  console.log(`[OnDemand] Triggering scrape for "${title}" (tmdb:${tmdbId})`);

  const task = contentType === 'movie'
    ? processMovie({ id: tmdbId })
    : processSeries({ id: tmdbId });

  task.catch(err =>
    console.error(`[OnDemand] Scrape failed for tmdb:${tmdbId}`, err.message)
  );
};

module.exports = { searchAndFetch, getOrFetchContent };