const { getStreamFromCineby } = require('../../ingestion/scraper/providers/providerC');
const { upsertStream }        = require('../../db/streams.queries');
const { getSubtitle }         = require('../subtitles/subtitles.service');
const pool                    = require('../../config/db');
const moviesDb                = require('../../db/movies.queries');
const { getActiveSubscription } = require('../../db/auth.queries');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getCachedStreams = async (contentType, contentId) => {
  const { rows } = await pool.query(
    `SELECT server_name, quality, language,
            stream_url, embed_url, stream_type, priority
     FROM streams
     WHERE content_type = $1
       AND content_id   = $2
       AND stream_type  = 'direct'
       AND is_active    = TRUE
     ORDER BY priority ASC`,
    [contentType, contentId]
  );
  return rows;
};

const formatResponse = (streams, contentId, contentType, subscription, subtitleUrl = null) => ({
  content_id:   contentId,
  content_type: contentType,
  show_ads:     false,
  subtitle_url: subtitleUrl,
  streams:      streams.map(s => ({
    server_name: s.server_name,
    quality:     s.quality     || 'auto',
    language:    s.language,
    stream_url:  s.stream_url  || null,
    embed_url:   s.embed_url   || null,
    stream_type: s.stream_type,
    priority:    s.priority,
  })),
});

const fetchSubtitle = async (tmdbId, contentType, contentId, season = null, episode = null) => {
  try {
    const subtitle = await getSubtitle(tmdbId, contentType, contentId, season, episode);
    return subtitle?.subtitle_url || null;
  } catch (err) {
    console.warn('[Streams] Subtítulo no encontrado:', err.message);
    return null;
  }
};

// ─── Movie streams ────────────────────────────────────────────────────────────

const getMovieStreams = async (movieId, userId) => {
  const movie = await moviesDb.findById(movieId);
  if (!movie) {
    const err = new Error('Película no encontrada');
    err.statusCode = 404;
    throw err;
  }

  console.log(`[Streams] Buscando streams para "${movie.title}"`);

  // 1. Verificar caché — solo streams directos
  const cached = await getCachedStreams('movie', movieId);

  if (cached.length > 0) {
    console.log(`[Streams] Stream en caché para "${movie.title}"`);
    const subtitleUrl  = await fetchSubtitle(movie.tmdb_id, 'movie', movieId);
    const subscription = userId ? await getActiveSubscription(userId) : null;
    return formatResponse(cached, movieId, 'movie', subscription, subtitleUrl);
  }

  // 2. Sin caché → scrapear ProviderC una sola vez
  console.log(`[Streams] Scrapeando ProviderC para "${movie.title}"`);
  const m3u8Url = await getStreamFromCineby(movie.tmdb_id, 'movie')
    .catch(err => {
      console.warn('[Streams] ProviderC falló:', err.message);
      return null;
    });

  if (!m3u8Url) {
    const err = new Error('Este contenido aún no está disponible. ¡Muy pronto habrá más contenido!');
    err.statusCode = 404;
    throw err;
  }

  // 3. Cachear en BD
  const directStream = {
    content_type: 'movie',
    content_id:   movieId,
    server_name:  'HD',
    quality:      'auto',
    language:     'en-sub',
    stream_url:   m3u8Url,
    embed_url:    null,
    stream_type:  'direct',
    priority:     1,
  };
  await upsertStream(directStream);

  const subtitleUrl  = await fetchSubtitle(movie.tmdb_id, 'movie', movieId);
  const subscription = userId ? await getActiveSubscription(userId) : null;
  return formatResponse([directStream], movieId, 'movie', subscription, subtitleUrl);
};

// ─── Episode streams ──────────────────────────────────────────────────────────

const getEpisodeStreams = async (episodeId, userId) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.series_id, e.season_number, e.episode_number,
            e.title, e.is_published, s.is_published AS series_published,
            s.tmdb_id, s.title AS series_title,
            s.original_title AS series_original_title,
            s.release_year
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1`,
    [episodeId]
  );

  const episode = rows[0];
  if (!episode || !episode.is_published || !episode.series_published) {
    const err = new Error('Episodio no encontrado');
    err.statusCode = 404;
    throw err;
  }

  console.log(`[Streams] Buscando S${episode.season_number}E${episode.episode_number} de "${episode.series_title}"`);

  // 1. Verificar caché
  const cached = await getCachedStreams('episode', episodeId);

  if (cached.length > 0) {
    console.log(`[Streams] Stream en caché para episodio ${episodeId}`);
    const subtitleUrl = await fetchSubtitle(
      episode.tmdb_id, 'episode', episodeId,
      episode.season_number, episode.episode_number
    );
    const subscription = userId ? await getActiveSubscription(userId) : null;
    return formatResponse(cached, episodeId, 'episode', subscription, subtitleUrl);
  }

  // 2. Sin caché → scrapear ProviderC
  console.log(`[Streams] Scrapeando ProviderC para episodio`);
  const m3u8Url = await getStreamFromCineby(
    episode.tmdb_id, 'tv',
    episode.season_number,
    episode.episode_number
  ).catch(err => {
    console.warn('[Streams] ProviderC episodio falló:', err.message);
    return null;
  });

  if (!m3u8Url) {
    const err = new Error('Este episodio aún no está disponible. ¡Muy pronto habrá más contenido!');
    err.statusCode = 404;
    throw err;
  }

  // 3. Cachear en BD
  const directStream = {
    content_type: 'episode',
    content_id:   episodeId,
    server_name:  'HD',
    quality:      'auto',
    language:     'en-sub',
    stream_url:   m3u8Url,
    embed_url:    null,
    stream_type:  'direct',
    priority:     1,
  };
  await upsertStream(directStream);

  const subtitleUrl = await fetchSubtitle(
    episode.tmdb_id, 'episode', episodeId,
    episode.season_number, episode.episode_number
  );
  const subscription = userId ? await getActiveSubscription(userId) : null;
  return formatResponse([directStream], episodeId, 'episode', subscription, subtitleUrl);
};

module.exports = { getMovieStreams, getEpisodeStreams };