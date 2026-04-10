const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { searchLimiter } = require('../../middleware/rateLimiter');

const { searchContent, getContent } = require('./content.controller');

  
router.get('/search',   auth, searchLimiter, searchContent);  // GET /api/content/search?q=titanic&type=movie
router.get('/:tmdb_id', auth, getContent);     // GET /api/content/597?type=movie

module.exports = router;