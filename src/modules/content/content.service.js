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
const moviesService = require('../movies/movies.service');
const seriesService = require('../series/series.service');

const getHomeCatalog = async ({
  movieLimit = 24,
  seriesLimit = 24,
  recentLimit = 12,
} = {}) => {
  const [moviePage, seriesPage] = await Promise.all([
    moviesService.getAll({ page: 1, limit: movieLimit }),
    seriesService.getAll({ page: 1, limit: seriesLimit }),
  ]);

  const movies = moviePage.items || [];
  const series = seriesPage.items || [];
  const recent = [
    ...movies.map((item) => ({ ...item, type: 'movie' })),
    ...series.map((item) => ({ ...item, type: 'series' })),
  ]
    .sort((left, right) =>
      new Date(right.created_at || 0).getTime() -
      new Date(left.created_at || 0).getTime()
    )
    .slice(0, recentLimit);

  const featured =
    recent.find((item) => Boolean(item.backdrop_url)) ||
    recent[0] ||
    null;

  return {
    featured,
    movies,
    series,
    recently_added: recent,
  };
};

const searchLocalCatalog = async (query, contentType, limit = 5) => {
  const table = contentType === 'movie' ? 'movies' : 'series';
  const { rows } = await pool.query(
    `SELECT id, tmdb_id, title, release_year, poster_url
     FROM ${table}
     WHERE is_published = TRUE
       AND (
         POSITION(LOWER($1) IN LOWER(title)) > 0
         OR POSITION(LOWER($1) IN LOWER(COALESCE(original_title, ''))) > 0
       )
     ORDER BY
       CASE
         WHEN LOWER(title) = LOWER($1) THEN 0
         WHEN LOWER(COALESCE(original_title, '')) = LOWER($1) THEN 1
         WHEN POSITION(LOWER($1) IN LOWER(title)) = 1 THEN 2
         ELSE 3
       END,
       created_at DESC
     LIMIT $2`,
    [query, limit]
  );

  return rows.map((item) => ({
    tmdb_id: item.tmdb_id || null,
    title: item.title,
    release_year: item.release_year || null,
    poster_url: item.poster_url || null,
    in_catalog: true,
    local_id: item.id,
  }));
};

const searchAndFetch = async (query, contentType = 'movie') => {
  const safeType = contentType === 'series' ? 'series' : 'movie';
  const local = await searchLocalCatalog(query, safeType, 5);

  if (local.length >= 5) return local;

  const endpoint = safeType === 'movie' ? '/search/movie' : '/search/tv';
  const remote = await tmdbFetcher.search(endpoint, query);
  if (!remote.length) return local;

  const table = safeType === 'movie' ? 'movies' : 'series';
  const candidates = remote.slice(0, 10);
  const tmdbIds = candidates
    .map((item) => Number(item.id))
    .filter(Number.isFinite);

  const existingByTmdb = new Map();
  if (tmdbIds.length) {
    const { rows } = await pool.query(
      `SELECT id, tmdb_id
       FROM ${table}
       WHERE tmdb_id = ANY($1::int[])`,
      [tmdbIds]
    );
    for (const item of rows) {
      existingByTmdb.set(Number(item.tmdb_id), item.id);
    }
  }

  const localTmdbIds = new Set(
    local
      .map((item) => Number(item.tmdb_id))
      .filter(Number.isFinite)
  );

  const remoteResults = candidates
    .filter((item) => !localTmdbIds.has(Number(item.id)))
    .map((item) => {
      const localId = existingByTmdb.get(Number(item.id)) || null;
      const releaseDate = item.release_date || item.first_air_date || null;

      return {
        tmdb_id: item.id,
        title: item.title || item.name,
        release_year: releaseDate
          ? parseInt(releaseDate.slice(0, 4), 10)
          : null,
        poster_url: item.poster_path
          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
          : null,
        in_catalog: Boolean(localId),
        local_id: localId,
      };
    });

  return [...local, ...remoteResults].slice(0, 5);
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

module.exports = { getHomeCatalog, searchAndFetch, getOrFetchContent };
