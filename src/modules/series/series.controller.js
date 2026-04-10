const seriesService = require('./series.service');
const { ok, error } = require('../../utils/response');

const listSeries = async (req, res, next) => {
  try {
    const { page, limit, genre_id } = req.query;
    const result = await seriesService.getAll({ page, limit, genre_id });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const getSeries = async (req, res, next) => {
  try {
    const series = await seriesService.getById(req.params.id);
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

    const episodes = await seriesService.getEpisodes(id, seasonNumber);
    return ok(res, episodes);
  } catch (err) {
    next(err);
  }
};

module.exports = { listSeries, getSeries, getEpisodes };