const express                   = require('express');
const router                    = express.Router();
const { getSubtitleForContent } = require('./subtitles.controller');

router.get('/:tmdbId', getSubtitleForContent);

module.exports = router;