const moviesDb = require('../../db/movies.queries');

const withPlayback = (movie) => {
  const {
    playback_ready: playbackReady,
    catalog_source_count: catalogSourceCountRaw,
    ...content
  } = movie;

  const catalogSourceCount = Number(catalogSourceCountRaw || 0);

  return {
    ...content,
    playback: {
      ready: playbackReady === true,
      has_catalog_sources: catalogSourceCount > 0,
      catalog_source_count: catalogSourceCount,
    },
  };
};

const getAll = async ({ page = 1, limit = 20, genre_id } = {}) => {
  const safePage  = Math.max(1, parseInt(page, 10));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const offset    = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    moviesDb.findAll({ limit: safeLimit, offset, genre_id }),
    moviesDb.countAll(genre_id),
  ]);

  return {
    items: items.map(withPlayback),
    pagination: {
      page:        safePage,
      limit:       safeLimit,
      total,
      total_pages: Math.ceil(total / safeLimit),
    },
  };
};

const getById = async (id) => {
  const movie = await moviesDb.findById(id);
  if (!movie) {
    const err = new Error('Movie not found');
    err.statusCode = 404;
    throw err;
  }
  return withPlayback(movie);
};

const getAllGenres = async () => {
  return moviesDb.findAllGenres();
};

module.exports = { getAll, getById, getAllGenres };