const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { listSeries, getSeries, getEpisodes } = require('./series.controller');

router.get('/',                          auth, listSeries);
router.get('/:id',                       auth, getSeries);
router.get('/:id/seasons/:season',       auth, getEpisodes);

module.exports = router;