const auth   = require('../../middleware/auth');
const { createSeriesController } = require('./series.controller');

const createSeriesRouter = (service) => {
  const router = require('express').Router();
  const { listSeries, getSeries, getEpisodes, getEpisode } =
    createSeriesController(service);

  router.get('/',                          auth, listSeries);
  router.get('/episodes/:episodeId',       auth, getEpisode);
  router.get('/:id/seasons/:season',       auth, getEpisodes);
  router.get('/:id',                       auth, getSeries);
  return router;
};

module.exports = createSeriesRouter();
module.exports.createSeriesRouter = createSeriesRouter;
