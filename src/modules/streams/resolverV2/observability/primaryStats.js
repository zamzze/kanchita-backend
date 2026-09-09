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
    expiring: 0, invalid: 0, legacyAvoided: 0, rolloutEvaluations: 0,
    eligible: 0, notSelected: 0, mediaDisabled: 0, guardSkipped: 0,
    guardOpened: 0, guardRecovered: 0, halfOpenProbe: 0,
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
  const recordRollout = (reason) => {
    counters.rolloutEvaluations += 1;
    if (reason === 'selected') counters.eligible += 1;
    else if (reason === 'rollout_zero' || reason === 'rollout_not_selected') {
      counters.notSelected += 1;
    } else if (reason === 'movie_disabled' || reason === 'episode_disabled') {
      counters.mediaDisabled += 1;
    }
  };
  const recordGuard = (event) => {
    if (event === 'skip') counters.guardSkipped += 1;
    else if (event === 'open') counters.guardOpened += 1;
    else if (event === 'recovery') counters.guardRecovered += 1;
    else if (event === 'probe') counters.halfOpenProbe += 1;
    else throw new Error('PRIMARY_STATS_INVALID_INPUT');
  };
  const snapshot = () => Object.freeze({
    ...counters,
    acceptRate: counters.attempts ? counters.accepted / counters.attempts : null,
    fallbackRate: counters.attempts ? counters.fallbacks / counters.attempts : null,
    legacyAvoidanceRate: counters.attempts
      ? counters.legacyAvoided / counters.attempts : null,
    eligibilityRate: counters.rolloutEvaluations
      ? counters.eligible / counters.rolloutEvaluations : null,
    primaryExecutionRate: counters.rolloutEvaluations
      ? counters.attempts / counters.rolloutEvaluations : null,
    guardSkipRate: counters.eligible ? counters.guardSkipped / counters.eligible : null,
    legacyAvoidanceAmongSelected: counters.eligible
      ? counters.legacyAvoided / counters.eligible : null,
    legacyAvoidanceOverall: counters.rolloutEvaluations
      ? counters.legacyAvoided / counters.rolloutEvaluations : null,
  });
  return Object.freeze({ record, recordRollout, recordGuard, snapshot });
};

module.exports = { createPrimaryStats };
