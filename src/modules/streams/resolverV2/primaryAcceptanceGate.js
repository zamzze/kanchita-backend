'use strict';

const { normalizeStreamCandidate } = require('./resolverContracts');
const { classifyLanguage, qualityTier } = require('./ranking/streamRanker');

const PRIMARY_MIN_EXPIRY_MS = 60_000;
const PRIMARY_CODES = Object.freeze({
  ACCEPTED: 'PRIMARY_ACCEPTED',
  NO_STREAM: 'PRIMARY_NO_STREAM',
  INVALID_STREAM: 'PRIMARY_INVALID_STREAM',
  UNVALIDATED: 'PRIMARY_UNVALIDATED',
  UNSUPPORTED_PROTOCOL: 'PRIMARY_UNSUPPORTED_PROTOCOL',
  EXPIRED: 'PRIMARY_EXPIRED',
  EXPIRING_TOO_SOON: 'PRIMARY_EXPIRING_TOO_SOON',
  HEADERS_UNSUPPORTED: 'PRIMARY_HEADERS_UNSUPPORTED',
  INCOMPATIBLE: 'PRIMARY_INCOMPATIBLE',
  UNKNOWN: 'PRIMARY_UNKNOWN',
});

const safeSummary = (stream, code) => Object.freeze({
  code,
  protocol: stream?.protocol || 'unknown',
  qualityTier: stream ? qualityTier(stream) : 'unknown',
  languageTier: stream
    ? classifyLanguage(stream.audioLanguage, stream.subtitleLanguage).tier : 'unknown',
  validated: stream?.validated === true,
  resolverStrategy: ['direct', 'http', 'browser'].includes(stream?.metadata?.resolverStrategy)
    ? stream.metadata.resolverStrategy : 'unknown',
});

const createPrimaryAcceptanceGate = ({
  now = Date.now,
  minimumExpiryMs = PRIMARY_MIN_EXPIRY_MS,
} = {}) => {
  if (typeof now !== 'function' || !Number.isInteger(minimumExpiryMs) || minimumExpiryMs < 0) {
    throw new Error('PRIMARY_GATE_INVALID_CONFIG');
  }
  const reject = (stream, code) => Object.freeze({
    accepted: false, code, summary: safeSummary(stream, code),
  });
  const evaluate = (candidate) => {
    if (candidate === null || candidate === undefined) {
      return reject(null, PRIMARY_CODES.NO_STREAM);
    }
    const stream = normalizeStreamCandidate(candidate);
    if (!stream) return reject(null, PRIMARY_CODES.INVALID_STREAM);
    if (stream.validated !== true) return reject(stream, PRIMARY_CODES.UNVALIDATED);
    if (stream.protocol !== 'hls') {
      return reject(stream, PRIMARY_CODES.UNSUPPORTED_PROTOCOL);
    }
    let parsed;
    try {
      parsed = new URL(stream.url);
    } catch {
      return reject(stream, PRIMARY_CODES.INVALID_STREAM);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return reject(stream, PRIMARY_CODES.INVALID_STREAM);
    }
    if (Object.keys(stream.headers).length > 0) {
      return reject(stream, PRIMARY_CODES.HEADERS_UNSUPPORTED);
    }
    if (!['direct', 'http'].includes(stream.metadata?.resolverStrategy)) {
      return reject(stream, PRIMARY_CODES.INCOMPATIBLE);
    }
    if (stream.expiresAt) {
      const remainingMs = new Date(stream.expiresAt).getTime() - now();
      if (remainingMs <= 0) return reject(stream, PRIMARY_CODES.EXPIRED);
      if (remainingMs < minimumExpiryMs) {
        return reject(stream, PRIMARY_CODES.EXPIRING_TOO_SOON);
      }
    }
    return Object.freeze({
      accepted: true,
      code: PRIMARY_CODES.ACCEPTED,
      summary: safeSummary(stream, PRIMARY_CODES.ACCEPTED),
    });
  };
  return Object.freeze({ evaluate });
};

module.exports = { PRIMARY_CODES, PRIMARY_MIN_EXPIRY_MS, createPrimaryAcceptanceGate };
