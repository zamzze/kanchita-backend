const seriesDb = require('../../db/series.queries');

const getAll = async ({ page = 1, limit = 20, genre_id } = {}) => {
  const safePage  = Math.max(1, parseInt(page, 10));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const offset    = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    seriesDb.findAll({ limit: safeLimit, offset, genre_id }),
    seriesDb.countAll(genre_id),
  ]);

  return {
    items,
    pagination: { page: safePage, limit: safeLimit, total, total_pages: Math.ceil(total / safeLimit) },
  };
};

const getById = async (id) => {
  const [series, seasons] = await Promise.all([
    seriesDb.findById(id),
    seriesDb.findSeasons(id),
  ]);

  if (!series) {
    const err = new Error('Series not found');
    err.statusCode = 404;
    throw err;
  }

  return { ...series, seasons };
};

const getEpisodes = async (seriesId, seasonNumber) => {
  const series = await seriesDb.findById(seriesId);
  if (!series) {
    const err = new Error('Series not found');
    err.statusCode = 404;
    throw err;
  }
  return seriesDb.findEpisodes(seriesId, seasonNumber);
};

module.exports = { getAll, getById, getEpisodes };