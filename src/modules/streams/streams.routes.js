const express = require('express');
const auth = require('../../middleware/auth');
const { createStreamsController } = require('./streams.controller');

const createStreamsRouter = (streamsService) => {
  const router = express.Router();
  const {
    getMovieStreams,
    getEpisodeStreams,
    prepareMovie,
    prepareEpisode,
  } = createStreamsController(streamsService);
  router.get('/movie/:id', auth, getMovieStreams);
  router.get('/episode/:id', auth, getEpisodeStreams);
  router.post('/movie/:id/prepare', auth, prepareMovie);
  router.post('/episode/:id/prepare', auth, prepareEpisode);
  return router;
};

module.exports = createStreamsRouter();
module.exports.createStreamsRouter = createStreamsRouter;
