const { searchAndFetch, getOrFetchContent } = require('./content.service');
const { ok, error } = require('../../utils/response');

const searchContent = async (req, res, next) => {
  try {
    const { q, type = 'movie' } = req.query;
    if (!q || q.trim().length < 2) {
      return error(res, 'Query must be at least 2 characters', 400);
    }
    const results = await searchAndFetch(q.trim(), type);
    return ok(res, results);
  } catch (err) {
    next(err);
  }
};

const getContent = async (req, res, next) => {
  try {
    const { tmdb_id }        = req.params;
    const { type = 'movie' } = req.query;
    const content            = await getOrFetchContent(parseInt(tmdb_id), type);
    return ok(res, content);
  } catch (err) {
    next(err);
  }
};

module.exports = { searchContent, getContent };