'use strict';

const CODE_COUNTERS = Object.freeze({
  PRIMARY_UNVALIDATED: 'unvalidated',
  PRIMARY_UNSUPPORTED_PROTOCOL: 'unsupportedProtocol',
  PRIMARY_HEADERS_UNSUPPORTED: 'headersUnsupported',
  PRIMARY_EXPIRED: 'expired',
  PRIMARY_EXPIRING_TOO_SOON: 'expiring',
  PRIMARY_INVALID_STREAM: 'invalid',
  PRIMARY_INCOMPATIBLE: 'invalid',
  PRIMARY_UNKNOWN: 'invalid',
});

const createPrimaryStats = () => {
  const counters = {
    attempts: 0, accepted: 0, fallbacks: 0, empty: 0, timeouts: 0, failed: 0,
    unvalidated: 0, unsupportedProtocol: 0, headersUnsupported: 0, expired: 0,
    expiring: 0, invalid: 0, legacyAvoided: 0,
  };
  const record = ({ status, code, fallback = false, legacyAvoided = false } = {}) => {
    if (typeof status !== 'string' || typeof fallback !== 'boolean' ||
        typeof legacyAvoided !== 'boolean') throw new Error('PRIMARY_STATS_INVALID_INPUT');
    counters.attempts += 1;
    if (status === 'accepted') counters.accepted += 1;
    else if (status === 'empty') counters.empty += 1;
    else if (status === 'timeout') counters.timeouts += 1;
    else if (status === 'failed' || status === 'aborted') counters.failed += 1;
    else if (status === 'rejected') {
      const counter = CODE_COUNTERS[code] || 'invalid';
      counters[counter] += 1;
    }
    if (fallback) counters.fallbacks += 1;
    if (legacyAvoided) counters.legacyAvoided += 1;
  };
  const snapshot = () => Object.freeze({
    ...counters,
    acceptRate: counters.attempts ? counters.accepted / counters.attempts : null,
    fallbackRate: counters.attempts ? counters.fallbacks / counters.attempts : null,
    legacyAvoidanceRate: counters.attempts
      ? counters.legacyAvoided / counters.attempts : null,
  });
  return Object.freeze({ record, snapshot });
};

module.exports = { createPrimaryStats };
