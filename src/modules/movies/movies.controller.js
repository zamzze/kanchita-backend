const moviesService  = require('./movies.service');
const { ok, error }  = require('../../utils/response');

const listMovies = async (req, res, next) => {
  try {
    const { page, limit, genre_id } = req.query;
    const result = await moviesService.getAll({ page, limit, genre_id });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const getMovie = async (req, res, next) => {
  try {
    const movie = await moviesService.getById(req.params.id);
    return ok(res, movie);
  } catch (err) {
    next(err);
  }
};
const listGenres = async (req, res, next) => {
  try {
    const genres = await moviesService.getAllGenres();
    return ok(res, genres);
  } catch (err) {
    next(err);
  }
};

module.exports = { listMovies, getMovie, listGenres };