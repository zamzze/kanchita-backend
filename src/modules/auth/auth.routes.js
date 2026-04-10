const router = require('express').Router();
const auth   = require('../../middleware/auth');
const { authLimiter } = require('../../middleware/rateLimiter');
const {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
} = require('./auth.controller');

router.post('/register', authLimiter, registerHandler);
router.post('/login',    authLimiter, loginHandler);
router.post('/refresh',  authLimiter, refreshHandler);
router.post('/logout',   auth,        logoutHandler);

module.exports = router;