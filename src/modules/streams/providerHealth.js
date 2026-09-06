'use strict';

const pool = require('../../config/db');

const createProviderHealthStore = (db = pool, {
  failureThreshold = 5,
  cooldownSeconds = 300,
} = {}) => ({
  isAvailable: async (providerId) => {
    const { rows } = await db.query(
      `SELECT circuit_open_until FROM stream_provider_health WHERE provider_id = $1`,
      [providerId]
    );
    return !rows[0]?.circuit_open_until ||
      new Date(rows[0].circuit_open_until).getTime() <= Date.now();
  },
  recordSuccess: async (providerId, durationMs) => {
    await db.query(
      `INSERT INTO stream_provider_health (
         provider_id, success_count, consecutive_failures, total_resolution_ms,
         last_success_at, circuit_open_until
       ) VALUES ($1, 1, 0, $2, NOW(), NULL)
       ON CONFLICT (provider_id) DO UPDATE SET
         success_count = stream_provider_health.success_count + 1,
         consecutive_failures = 0,
         total_resolution_ms = stream_provider_health.total_resolution_ms + EXCLUDED.total_resolution_ms,
         last_success_at = NOW(), circuit_open_until = NULL, updated_at = NOW()`,
      [providerId, Math.max(0, Math.round(durationMs))]
    );
  },
  recordFailure: async (providerId, durationMs) => {
    await db.query(
      `INSERT INTO stream_provider_health (
       provider_id, failure_count, consecutive_failures, total_resolution_ms,
       last_failure_at, circuit_open_until
       ) VALUES (
         $1, 1, 1, $2, NOW(),
         CASE WHEN $3 <= 1
           THEN NOW() + ($4::double precision * INTERVAL '1 second')
           ELSE NULL
         END
       )
       ON CONFLICT (provider_id) DO UPDATE SET
         failure_count = stream_provider_health.failure_count + 1,
         consecutive_failures = stream_provider_health.consecutive_failures + 1,
         total_resolution_ms = stream_provider_health.total_resolution_ms + EXCLUDED.total_resolution_ms,
         last_failure_at = NOW(),
         circuit_open_until = CASE
           WHEN stream_provider_health.consecutive_failures + 1 >= $3
             THEN NOW() + ($4::double precision * INTERVAL '1 second')
           ELSE stream_provider_health.circuit_open_until
         END,
         updated_at = NOW()`,
      [providerId, Math.max(0, Math.round(durationMs)), failureThreshold, cooldownSeconds]
    );
  },
});

module.exports = { createProviderHealthStore };
