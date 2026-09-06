const jwt = require('jsonwebtoken');
const {
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_IN,
  JWT_ISSUER,
  JWT_ACCESS_AUDIENCE,
  JWT_REFRESH_AUDIENCE,
} = require('../config/env');

const JWT_ALGORITHM = 'HS256';
const ACCESS_TOKEN_TYPE = 'access';
const REFRESH_TOKEN_TYPE = 'refresh';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const unauthorized = (message) => {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
};

const signAccessToken = ({ id, sessionId, plan_type }) => jwt.sign(
  { sid: sessionId, token_type: ACCESS_TOKEN_TYPE, plan: plan_type },
  JWT_SECRET,
  {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_ACCESS_AUDIENCE,
    subject: id,
    expiresIn: JWT_EXPIRES_IN,
  }
);

const signRefreshToken = ({ id, sessionId, tokenId }) => jwt.sign(
  { sid: sessionId, token_type: REFRESH_TOKEN_TYPE },
  JWT_REFRESH_SECRET,
  {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_REFRESH_AUDIENCE,
    subject: id,
    jwtid: tokenId,
    expiresIn: JWT_REFRESH_IN,
  }
);

const verifyTypedToken = ({ token, secret, audience, expectedType, label }) => {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience,
    });
    if (
      payload.token_type !== expectedType ||
      !UUID_PATTERN.test(payload.sub || '') ||
      !UUID_PATTERN.test(payload.sid || '') ||
      (expectedType === REFRESH_TOKEN_TYPE && !UUID_PATTERN.test(payload.jti || ''))
    ) {
      throw unauthorized(`Invalid ${label} token`);
    }
    return payload;
  } catch {
    throw unauthorized(`Invalid ${label} token`);
  }
};

const verifyAccessToken = (token) => verifyTypedToken({
  token,
  secret: JWT_SECRET,
  audience: JWT_ACCESS_AUDIENCE,
  expectedType: ACCESS_TOKEN_TYPE,
  label: 'access',
});

const verifyRefreshToken = (token) => verifyTypedToken({
  token,
  secret: JWT_REFRESH_SECRET,
  audience: JWT_REFRESH_AUDIENCE,
  expectedType: REFRESH_TOKEN_TYPE,
  label: 'refresh',
});

module.exports = {
  JWT_ALGORITHM,
  ACCESS_TOKEN_TYPE,
  REFRESH_TOKEN_TYPE,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
