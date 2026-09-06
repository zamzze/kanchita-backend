'use strict';

const pool = require('../../config/db');

const METRIC_NAMES = new Set([
  'stream_requests_total',
  'stream_ready_first_request_total',
  'stream_pending_total',
  'stream_unavailable_total',
  'cache_hit_total',
  'cache_miss_total',
  'prewarm_requested_total',
  'prewarm_hit_total',
  'provider_resolution_total',
  'provider_success_total',
  'provider_failure_total',
  'browser_resolution_total',
  'browser_slot_wait_ms',
  'resolver_duration_ms',
  'hls_validation_ms',
  'ad_marked_stream_total',
  'subtitle_subdl_success_total',
  'subtitle_opensubtitles_success_total',
]);

const createMetricsStore = (db = pool) => {
  const assertName = (name) => {
    if (!METRIC_NAMES.has(name)) throw new Error('Unknown metric');
  };
  return {
    increment: async (name, amount = 1) => {
      assertName(name);
      await db.query(
        `INSERT INTO stream_metrics (metric_name, metric_value)
         VALUES ($1, $2)
         ON CONFLICT (metric_name) DO UPDATE SET
           metric_value = stream_metrics.metric_value + EXCLUDED.metric_value,
           updated_at = NOW()`,
        [name, amount]
      );
    },
    observe: async (name, milliseconds) => {
      assertName(name);
      await db.query(
        `INSERT INTO stream_metrics
           (metric_name, duration_total_ms, duration_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (metric_name) DO UPDATE SET
           duration_total_ms = stream_metrics.duration_total_ms + EXCLUDED.duration_total_ms,
           duration_count = stream_metrics.duration_count + 1,
           updated_at = NOW()`,
        [name, Math.max(0, Math.round(milliseconds))]
      );
    },
  };
};

module.exports = { METRIC_NAMES, createMetricsStore };
