'use strict';

const KINDS = new Set(['source', 'resolver']);
const STATES = new Set(['closed', 'open', 'half_open']);
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const healthError = () => Object.assign(new Error('V2_HEALTH_INVALID_INPUT'), {
  code: 'V2_HEALTH_INVALID_INPUT',
});

const createV2HealthStore = ({
  failureThreshold = 5,
  cooldownMs = 300_000,
  successThreshold = 1,
  clock = Date.now,
  onEvent = null,
} = {}) => {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 20 ||
      !Number.isInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > 3_600_000 ||
      !Number.isInteger(successThreshold) || successThreshold < 1 || successThreshold > 5 ||
      typeof clock !== 'function' || (onEvent && typeof onEvent !== 'function')) throw healthError();

  const entries = new Map();
  const validate = (kind, id) => {
    if (!KINDS.has(kind) || typeof id !== 'string' || !SAFE_ID.test(id)) throw healthError();
  };
  const keyFor = (kind, id) => `${kind}:${id}`;
  const fresh = (kind, id) => ({
    id, kind, state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 0,
    totalAttempts: 0, totalSuccesses: 0, totalFailures: 0, totalTimeouts: 0,
    lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, openedAt: null,
    cooldownUntil: null, lastErrorCode: null, totalDurationMs: 0, probeInFlight: false,
  });
  const entryFor = (kind, id) => {
    validate(kind, id);
    const key = keyFor(kind, id);
    if (!entries.has(key)) entries.set(key, fresh(kind, id));
    return entries.get(key);
  };
  const emit = (type, entry) => {
    try { onEvent?.(type, entry.kind); } catch { /* best effort */ }
  };
  const duration = (value) => {
    if (!Number.isFinite(value) || value < 0) throw healthError();
    return value;
  };
  const publicEntry = (entry) => {
    const { probeInFlight: _probeInFlight, ...safe } = entry;
    return Object.freeze({ ...safe });
  };
  const open = (entry, now) => {
    entry.state = 'open';
    entry.openedAt = now;
    entry.cooldownUntil = now + cooldownMs;
    entry.consecutiveSuccesses = 0;
    entry.probeInFlight = false;
    emit('open', entry);
  };

  const canAttempt = (kind, id) => {
    const entry = entryFor(kind, id);
    const now = clock();
    if (entry.state === 'closed') {
      entry.totalAttempts += 1;
      entry.lastAttemptAt = now;
      return true;
    }
    if (entry.state === 'open' && now >= entry.cooldownUntil) {
      entry.state = 'half_open';
      entry.probeInFlight = true;
      entry.totalAttempts += 1;
      entry.lastAttemptAt = now;
      emit('half_open_probe', entry);
      return true;
    }
    if (entry.state === 'open' || entry.probeInFlight) {
      emit('skip', entry);
      return false;
    }
    entry.probeInFlight = true;
    entry.totalAttempts += 1;
    entry.lastAttemptAt = now;
    emit('half_open_probe', entry);
    return true;
  };

  const recordSuccess = (kind, id, { durationMs = 0 } = {}) => {
    const entry = entryFor(kind, id);
    const now = clock();
    entry.totalSuccesses += 1;
    entry.consecutiveSuccesses += 1;
    entry.consecutiveFailures = 0;
    entry.lastSuccessAt = now;
    entry.lastErrorCode = null;
    entry.totalDurationMs += duration(durationMs);
    if (entry.state === 'half_open') {
      entry.probeInFlight = false;
      if (entry.consecutiveSuccesses >= successThreshold) {
        entry.state = 'closed';
        entry.openedAt = null;
        entry.cooldownUntil = null;
        entry.consecutiveSuccesses = 0;
        emit('recovery', entry);
      }
    }
    return publicEntry(entry);
  };

  const recordFailure = (kind, id, { durationMs = 0, errorCode, timeout = false } = {}) => {
    const entry = entryFor(kind, id);
    const now = clock();
    entry.totalFailures += 1;
    if (timeout === true) entry.totalTimeouts += 1;
    entry.consecutiveFailures += 1;
    entry.consecutiveSuccesses = 0;
    entry.lastFailureAt = now;
    entry.lastErrorCode = typeof errorCode === 'string' && SAFE_CODE.test(errorCode)
      ? errorCode : 'COMPONENT_FAILURE';
    entry.totalDurationMs += duration(durationMs);
    if (entry.state === 'half_open' || entry.consecutiveFailures >= failureThreshold) {
      open(entry, now);
    }
    return publicEntry(entry);
  };

  const cancelAttempt = (kind, id) => {
    const entry = entryFor(kind, id);
    if (entry.state === 'half_open') entry.probeInFlight = false;
  };
  const get = (kind, id) => publicEntry(entryFor(kind, id));
  const snapshot = () => Object.freeze([...entries.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .map(publicEntry));
  const reset = (kind, id) => {
    validate(kind, id);
    entries.set(keyFor(kind, id), fresh(kind, id));
    return get(kind, id);
  };

  return Object.freeze({ canAttempt, recordSuccess, recordFailure, cancelAttempt,
    get, snapshot, reset, states: Object.freeze([...STATES]) });
};

module.exports = { createV2HealthStore };
