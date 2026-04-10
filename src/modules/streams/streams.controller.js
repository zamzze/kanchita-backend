const streamsService = require('./streams.service');
const { ok }         = require('../../utils/response');

const getMovieStreams = async (req, res, next) => {
  try {
    const result = await streamsService.getMovieStreams(req.params.id, req.user.sub);
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const getEpisodeStreams = async (req, res, next) => {
  try {
    const result = await streamsService.getEpisodeStreams(req.params.id, req.user.sub);
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

module.exports = { getMovieStreams, getEpisodeStreams };