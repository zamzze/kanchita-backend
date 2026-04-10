const { getTrendingMovies, getTrendingSeries } = require('../tmdb/tmdbFetcher');
const { processMovie, processSeries }          = require('../ingestionService');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const run = async () => {
  const MOVIE_PAGES  = parseInt(process.env.INITIAL_MOVIE_PAGES  || '5');
  const SERIES_PAGES = parseInt(process.env.INITIAL_SERIES_PAGES || '3');

  console.log(`[InitialLoad] Starting — ${MOVIE_PAGES} movie pages, ${SERIES_PAGES} series pages`);

  for (let page = 1; page <= MOVIE_PAGES; page++) {
    console.log(`[InitialLoad] Movies page ${page}/${MOVIE_PAGES}`);
    const res = await getTrendingMovies(page);
    for (const movie of res.results) {
      await processMovie(movie);
      await delay(2000);
    }
  }

  for (let page = 1; page <= SERIES_PAGES; page++) {
    console.log(`[InitialLoad] Series page ${page}/${SERIES_PAGES}`);
    const res = await getTrendingSeries(page);
    for (const serie of res.results) {
      await processSeries(serie);
      await delay(3000);
    }
  }

  console.log('[InitialLoad] Done.');
  process.exit(0);
};

run().catch(err => {
  console.error('[InitialLoad] Fatal error:', err);
  process.exit(1);
});