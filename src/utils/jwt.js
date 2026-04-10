const jwt = require('jsonwebtoken');
const {
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_IN,
} = require('../config/env');

const signAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, email: user.email, plan: user.plan_type },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

const signRefreshToken = (user) =>
  jwt.sign(
    { sub: user.id },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_IN }
  );

const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const error = new Error(
      err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token'
    );
    error.statusCode = 401;
    throw error;
  }
};

const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (err) {
    const error = new Error(
      err.name === 'TokenExpiredError' ? 'Refresh token expired' : 'Invalid refresh token'
    );
    error.statusCode = 401;
    throw error;
  }
};

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };