const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { saveProgress, listHistory, fetchProgress } = require('./history.controller');

router.post('/',                              auth, saveProgress);
router.get('/',                               auth, listHistory);
router.get('/:content_type/:content_id',      auth, fetchProgress);

module.exports = router;    