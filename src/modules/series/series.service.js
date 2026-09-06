const seriesDb = require('../../db/series.queries');

const createSeriesService = ({ db } = {}) => {
const getAll = async ({ page = 1, limit = 20, genre_id } = {}) => {
  const safePage  = Math.max(1, parseInt(page, 10));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const offset    = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    seriesDb.findAll({ limit: safeLimit, offset, genre_id }, db),
    seriesDb.countAll(genre_id, db),
  ]);

  return {
    items,
    pagination: { page: safePage, limit: safeLimit, total, total_pages: Math.ceil(total / safeLimit) },
  };
};

const getById = async (id) => {
  const [series, seasons] = await Promise.all([
    seriesDb.findById(id, db),
    seriesDb.findSeasons(id, db),
  ]);

  if (!series) {
    const err = new Error('Series not found');
    err.statusCode = 404;
    throw err;
  }

  return { ...series, seasons };
};

const getEpisodes = async (seriesId, seasonNumber) => {
  const series = await seriesDb.findById(seriesId, db);
  if (!series) {
    const err = new Error('Series not found');
    err.statusCode = 404;
    throw err;
  }
  return seriesDb.findEpisodes(seriesId, seasonNumber, db);
};

const getEpisodeById = async (episodeId) => {
  const episode = await seriesDb.findEpisodeById(episodeId, db);
  if (!episode) {
    const err = new Error('Episode not found');
    err.statusCode = 404;
    err.code = 'EPISODE_NOT_FOUND';
    throw err;
  }
  return episode;
};

return { getAll, getById, getEpisodes, getEpisodeById };
};

module.exports = {
  ...createSeriesService(),
  createSeriesService,
};
