const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { getMovieStreams, getEpisodeStreams } = require('./streams.controller');

router.get('/movie/:id',   auth, getMovieStreams);
router.get('/episode/:id', auth, getEpisodeStreams);

module.exports = router;