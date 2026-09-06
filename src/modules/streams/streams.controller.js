const streamsService = require('./streams.service');
const { isPendingResponse } = require('./streams.service');
const { ok } = require('../../utils/response');

const sendResult = (res, result) => {
  if (isPendingResponse(result)) {
    res.set('Retry-After', String(Math.ceil(result.retry_after_ms / 1000)));
    return ok(res, result, 202);
  }
  return ok(res, result);
};

const createStreamsController = (service = streamsService) => ({
  getMovieStreams: async (req, res, next) => {
    try {
      return sendResult(res, await service.getMovieStreams(req.params.id, req.user.sub));
    } catch (err) {
      return next(err);
    }
  },
  getEpisodeStreams: async (req, res, next) => {
    try {
      return sendResult(res, await service.getEpisodeStreams(req.params.id, req.user.sub));
    } catch (err) {
      return next(err);
    }
  },
});

const { getMovieStreams, getEpisodeStreams } = createStreamsController();

module.exports = {
  createStreamsController,
  getMovieStreams,
  getEpisodeStreams,
};
