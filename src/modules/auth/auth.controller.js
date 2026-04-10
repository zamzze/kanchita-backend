const authService    = require('./auth.service');
const { ok, created, error } = require('../../utils/response');

const registerHandler = async (req, res, next) => {
  try {
    const { email, password, display_name } = req.body;

    if (!email || !password) {
      return error(res, 'Email and password are required', 400);
    }
    if (password.length < 8) {
      return error(res, 'Password must be at least 8 characters', 400);
    }

    const user = await authService.register({ email, password, displayName: display_name });
    return created(res, user);
  } catch (err) {
    next(err);
  }
};

const loginHandler = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return error(res, 'Email and password are required', 400);
    }

    const result = await authService.login({ email, password });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const refreshHandler = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return error(res, 'Refresh token required', 400);
    }

    const tokens = await authService.refresh(refresh_token);
    return ok(res, tokens);
  } catch (err) {
    next(err);
  }
};

const logoutHandler = async (req, res, next) => {
  try {
    await authService.logout(req.user.sub);
    return ok(res, { message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};

module.exports = { registerHandler, loginHandler, refreshHandler, logoutHandler };