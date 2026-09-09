'use strict';

const { createLatencyHistogram } = require('./latencyHistogram');

const COUNTERS = Object.freeze([
  'source_circuit_open', 'source_circuit_skip', 'source_half_open_probe',
  'source_circuit_recovery', 'resolver_circuit_open', 'resolver_circuit_skip',
  'resolver_half_open_probe', 'resolver_circuit_recovery',
]);

const createV2Observability = ({ maxSamples = 256 } = {}) => {
  const histogram = createLatencyHistogram({ maxSamples });
  const counters = Object.fromEntries(COUNTERS.map((name) => [name, 0]));
  const observe = (series, durationMs) => histogram.observe(series, durationMs);
  const increment = (name, amount = 1) => {
    if (!Object.hasOwn(counters, name) || !Number.isInteger(amount) || amount < 0) {
      throw Object.assign(new Error('V2_OBSERVABILITY_INVALID_INPUT'), {
        code: 'V2_OBSERVABILITY_INVALID_INPUT',
      });
    }
    counters[name] += amount;
  };
  const snapshot = () => Object.freeze({
    latency: histogram.snapshotAll(),
    counters: Object.freeze({ ...counters }),
  });
  return Object.freeze({ observe, increment, snapshot });
};

module.exports = { COUNTERS, createV2Observability };
