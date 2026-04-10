const { verifyAccessToken } = require('../utils/jwt');
const { error } = require('../utils/response');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return error(res, 'No token provided', 401);
  }

  try {
    const token   = header.split(' ')[1];
    req.user      = verifyAccessToken(token);
    next();
  } catch {
    return error(res, 'Invalid or expired token', 401);
  }
};