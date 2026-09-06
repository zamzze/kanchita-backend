'use strict';

const crypto = require('node:crypto');

const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

const refreshTokenHashMatches = (token, storedHash) => {
  if (typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/.test(storedHash)) {
    return false;
  }

  const actual = Buffer.from(hashRefreshToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return crypto.timingSafeEqual(actual, expected);
};

module.exports = { hashRefreshToken, refreshTokenHashMatches };
