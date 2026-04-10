const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { listMovies, getMovie, listGenres  } = require('./movies.controller');

router.get('/genres', auth, listGenres);
router.get('/',    auth, listMovies);
router.get('/:id', auth, getMovie);

module.exports = router;