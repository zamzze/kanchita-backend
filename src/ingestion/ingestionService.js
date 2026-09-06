const tmdbFetcher   = require('./tmdb/tmdbFetcher');
const {
  normalizeMovie,
  normalizeSeries,
  normalizeEpisode,
} = require('./normalizer/movieNormalizer');
const db            = require('../db/ingestion.queries');
const logDb         = require('../db/scraper_log.queries');
const { createResolutionQueue } = require('../modules/streams/resolutionQueue');
const { redactSensitive } = require('../utils/redact');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const processMovie = async (tmdbMovie, {
  resolutionQueue = createResolutionQueue(),
} = {}) => {
  try {
    const detail     = await tmdbFetcher.getMovieDetail(tmdbMovie.id);
    const normalized = normalizeMovie(detail);
    const { id: movieId } = await db.upsertMovie(normalized);
    await db.upsertGenres('movie', movieId, normalized.genres);

    await resolutionQueue.enqueue('movie', movieId);

    await logDb.log({
      contentType:  'movie',
      contentId:    movieId,
      tmdbId:       tmdbMovie.id,
      status:       'queued',
      streamsFound: 0,
    });

    console.log(`[Ingestion] Movie "${normalized.title}" — stream queued`);
  } catch (err) {
    console.error(`[Ingestion] Failed movie tmdb:${tmdbMovie.id}`, redactSensitive(err.message));
  }
};

const processSeries = async (tmdbSerie) => {
  try {
    const detail     = await tmdbFetcher.getSeriesDetail(tmdbSerie.id);
    const normalized = normalizeSeries(detail);
    const { id: seriesId } = await db.upsertSeries(normalized);
    await db.upsertGenres('series', seriesId, normalized.genres);

    for (let s = 1; s <= normalized.seasons; s++) {
      const season = await tmdbFetcher.getSeriesSeason(tmdbSerie.id, s);
      if (!season.episodes) continue;

      for (const tmdbEpisode of season.episodes) {
        const ep = normalizeEpisode(tmdbEpisode, seriesId);
        await db.upsertEpisode(ep);
      }
      await delay(1000);
    }

    console.log(`[Ingestion] Series "${normalized.title}" processed`);
  } catch (err) {
    console.error(`[Ingestion] Failed series tmdb:${tmdbSerie.id}`, redactSensitive(err.message));
  }
};

const runIngestionJob = async () => {
  console.log('[Ingestion] Starting job...');
  try {
    const [moviesRes, seriesRes] = await Promise.all([
      tmdbFetcher.getTrendingMovies(),
      tmdbFetcher.getTrendingSeries(),
    ]);

    for (const movie of moviesRes.results.slice(0, 20)) {
      await processMovie(movie);
      await delay(2000);
    }

    for (const serie of seriesRes.results.slice(0, 10)) {
      await processSeries(serie);
      await delay(3000);
    }

    console.log('[Ingestion] Job completed.');
  } catch (err) {
    console.error('[Ingestion] Job failed:', redactSensitive(err.message));
  }
};

module.exports = { runIngestionJob, processMovie, processSeries };
