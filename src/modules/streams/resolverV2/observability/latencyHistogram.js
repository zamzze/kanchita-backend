'use strict';

const DEFAULT_SERIES = Object.freeze([
  'source_http', 'resolver_http', 'resolver_direct', 'shadow_total', 'primary_total',
]);

const histogramError = () => Object.assign(new Error('V2_HISTOGRAM_INVALID_INPUT'), {
  code: 'V2_HISTOGRAM_INVALID_INPUT',
});

const createLatencyHistogram = ({ maxSamples = 256, series = DEFAULT_SERIES } = {}) => {
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 4096 ||
      !Array.isArray(series) || series.length === 0 ||
      series.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item))) {
    throw histogramError();
  }
  const unique = [...new Set(series)];
  if (unique.length !== series.length) throw histogramError();
  const buffers = new Map(unique.map((name) => [name, { values: [], cursor: 0 }]));
  const bufferFor = (name) => {
    const buffer = buffers.get(name);
    if (!buffer) throw histogramError();
    return buffer;
  };
  const observe = (name, durationMs) => {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw histogramError();
    const buffer = bufferFor(name);
    if (buffer.values.length < maxSamples) buffer.values.push(durationMs);
    else {
      buffer.values[buffer.cursor] = durationMs;
      buffer.cursor = (buffer.cursor + 1) % maxSamples;
    }
  };
  const snapshot = (name) => {
    const values = [...bufferFor(name).values].sort((a, b) => a - b);
    if (values.length === 0) {
      return Object.freeze({ count: 0, min: null, max: null, avg: null, p50: null, p95: null });
    }
    const percentile = (ratio) => values[Math.max(0, Math.ceil(values.length * ratio) - 1)];
    const sum = values.reduce((total, value) => total + value, 0);
    return Object.freeze({
      count: values.length,
      min: values[0],
      max: values.at(-1),
      avg: sum / values.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
    });
  };
  const snapshotAll = () => Object.freeze(Object.fromEntries(
    unique.map((name) => [name, snapshot(name)]),
  ));
  return Object.freeze({ observe, snapshot, snapshotAll });
};

module.exports = { DEFAULT_SERIES, createLatencyHistogram };
