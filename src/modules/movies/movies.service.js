const moviesDb = require('../../db/movies.queries');

const getAll = async ({ page = 1, limit = 20, genre_id } = {}) => {
  const safePage  = Math.max(1, parseInt(page, 10));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const offset    = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    moviesDb.findAll({ limit: safeLimit, offset, genre_id }),
    moviesDb.countAll(genre_id),
  ]);

  return {
    items,
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
  return movie;
};

const getAllGenres = async () => {
  return moviesDb.findAllGenres();
};

module.exports = { getAll, getById, getAllGenres };