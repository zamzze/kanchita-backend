'use strict';

const OUTCOMES = new Set(['accepted', 'empty', 'rejected', 'timeout', 'failed']);
const TECHNICAL = new Set(['accepted', 'timeout', 'failed']);

const guardError = () => Object.assign(new Error('PRIMARY_GUARD_INVALID_CONFIG'), {
  code: 'PRIMARY_GUARD_INVALID_CONFIG',
});

const createPrimaryRuntimeGuard = ({
  enabled = true,
  minimumAttempts = 10,
  failureRateThreshold = 50,
  timeoutRateThreshold = 40,
  windowSize = 20,
  cooldownMs = 120_000,
  clock = Date.now,
} = {}) => {
  if (typeof enabled !== 'boolean' || !Number.isInteger(minimumAttempts) ||
      minimumAttempts < 3 || minimumAttempts > 100 || !Number.isInteger(windowSize) ||
      windowSize < minimumAttempts || windowSize > 500 ||
      !Number.isInteger(failureRateThreshold) || failureRateThreshold < 1 ||
      failureRateThreshold > 100 || !Number.isInteger(timeoutRateThreshold) ||
      timeoutRateThreshold < 1 || timeoutRateThreshold > 100 ||
      !Number.isInteger(cooldownMs) || cooldownMs < 10_000 || cooldownMs > 3_600_000 ||
      typeof clock !== 'function') throw guardError();

  let state = 'closed';
  let cooldownUntil = null;
  let probeInFlight = false;
  const samples = [];

  const rates = () => {
    const attempts = samples.length;
    const failures = samples.filter((outcome) => outcome === 'timeout' || outcome === 'failed').length;
    const timeouts = samples.filter((outcome) => outcome === 'timeout').length;
    return {
      technicalAttempts: attempts,
      failures,
      timeouts,
      failureRate: attempts ? failures / attempts : null,
      timeoutRate: attempts ? timeouts / attempts : null,
    };
  };
  const snapshot = () => Object.freeze({
    enabled, state, ...rates(), probeInFlight,
    cooldownRemainingMs: state === 'open'
      ? Math.max(0, cooldownUntil - clock()) : 0,
    windowSize,
  });
  const open = () => {
    state = 'open';
    cooldownUntil = clock() + cooldownMs;
    probeInFlight = false;
  };
  const close = () => {
    state = 'closed';
    cooldownUntil = null;
    probeInFlight = false;
    samples.length = 0;
  };

  const canAttempt = () => {
    if (!enabled) return Object.freeze({ allowed: true, state: 'closed', probe: false });
    if (state === 'closed') {
      return Object.freeze({ allowed: true, state, probe: false });
    }
    if (state === 'open' && clock() >= cooldownUntil) {
      state = 'half_open';
      probeInFlight = true;
      return Object.freeze({ allowed: true, state, probe: true });
    }
    if (state === 'half_open' && !probeInFlight) {
      probeInFlight = true;
      return Object.freeze({ allowed: true, state, probe: true });
    }
    return Object.freeze({ allowed: false, state, probe: false });
  };

  const recordOutcome = (outcome) => {
    if (!OUTCOMES.has(outcome)) throw guardError();
    if (!enabled) return Object.freeze({ event: null, snapshot: snapshot() });
    if (state === 'half_open') {
      if (!probeInFlight) throw guardError();
      if (outcome === 'timeout' || outcome === 'failed') {
        open();
        return Object.freeze({ event: 'open', snapshot: snapshot() });
      }
      close();
      return Object.freeze({ event: 'recovery', snapshot: snapshot() });
    }
    if (state === 'open') return Object.freeze({ event: null, snapshot: snapshot() });
    if (TECHNICAL.has(outcome)) {
      samples.push(outcome);
      if (samples.length > windowSize) samples.shift();
      const current = rates();
      if (current.technicalAttempts >= minimumAttempts &&
          (current.failureRate * 100 >= failureRateThreshold ||
           current.timeoutRate * 100 >= timeoutRateThreshold)) {
        open();
        return Object.freeze({ event: 'open', snapshot: snapshot() });
      }
    }
    return Object.freeze({ event: null, snapshot: snapshot() });
  };

  const cancelAttempt = () => {
    if (state === 'half_open') probeInFlight = false;
  };

  return Object.freeze({ canAttempt, recordOutcome, cancelAttempt, snapshot });
};

module.exports = { createPrimaryRuntimeGuard };
