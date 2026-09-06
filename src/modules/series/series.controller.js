const seriesService = require('./series.service');
const { ok, error } = require('../../utils/response');

const createSeriesController = (service = seriesService) => {
const listSeries = async (req, res, next) => {
  try {
    const { page, limit, genre_id } = req.query;
    const result = await service.getAll({ page, limit, genre_id });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const getSeries = async (req, res, next) => {
  try {
    const series = await service.getById(req.params.id);
    return ok(res, series);
  } catch (err) {
    next(err);
  }
};

const getEpisodes = async (req, res, next) => {
  try {
    const { id, season } = req.params;

    const seasonNumber = parseInt(season, 10);
    if (isNaN(seasonNumber) || seasonNumber < 1) {
      return error(res, 'Invalid season number', 400);
    }

    const episodes = await service.getEpisodes(id, seasonNumber);
    return ok(res, episodes);
  } catch (err) {
    next(err);
  }
};

const getEpisode = async (req, res, next) => {
  try {
    return ok(res, await service.getEpisodeById(req.params.episodeId));
  } catch (err) {
    return next(err);
  }
};

return { listSeries, getSeries, getEpisodes, getEpisode };
};

module.exports = {
  ...createSeriesController(),
  createSeriesController,
};
