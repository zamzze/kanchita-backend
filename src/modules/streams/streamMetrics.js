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
  'resolver_v2_shadow_attempt_total',
  'resolver_v2_shadow_success_total',
  'resolver_v2_shadow_empty_total',
  'resolver_v2_shadow_failure_total',
  'resolver_v2_shadow_timeout_total',
  'resolver_v2_shadow_duration_ms',
  'resolver_v2_source_circuit_open_total',
  'resolver_v2_source_circuit_skip_total',
  'resolver_v2_source_half_open_probe_total',
  'resolver_v2_source_circuit_recovery_total',
  'resolver_v2_resolver_circuit_open_total',
  'resolver_v2_resolver_circuit_skip_total',
  'resolver_v2_resolver_half_open_probe_total',
  'resolver_v2_resolver_circuit_recovery_total',
  'resolver_v2_shadow_comparison_total',
  'resolver_v2_shadow_ready_comparison_total',
  'resolver_v2_shadow_would_avoid_browser_total',
  'resolver_v2_legacy_browser_total',
  'resolver_v2_shadow_better_total',
  'resolver_v2_shadow_equivalent_total',
  'resolver_v2_shadow_legacy_better_total',
  'resolver_v2_primary_attempt_total',
  'resolver_v2_primary_success_total',
  'resolver_v2_primary_fallback_total',
  'resolver_v2_primary_timeout_total',
  'resolver_v2_primary_failure_total',
  'resolver_v2_primary_rejected_total',
  'resolver_v2_primary_legacy_avoided_total',
  'resolver_v2_primary_duration_ms',
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
