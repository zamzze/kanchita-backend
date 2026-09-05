const express                   = require('express');
const router                    = express.Router();
const auth                      = require('../../middleware/auth');
const { getSubtitleForContent } = require('./subtitles.controller');

router.get('/:tmdbId', auth, getSubtitleForContent);

module.exports = router;
