'use strict';

const pool = require('../../config/db');
const {
  STREAM_BROWSER_MAX_CONCURRENT,
  STREAM_WORKER_HEARTBEAT_SECONDS,
} = require('../../config/env');

const createHealthService = ({
  db = pool,
  browserLimit = STREAM_BROWSER_MAX_CONCURRENT,
  heartbeatSeconds = STREAM_WORKER_HEARTBEAT_SECONDS,
} = {}) => ({
  live: async () => ({ status: 'live' }),
  ready: async () => {
    await db.query('SELECT 1');
    const migration = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations
         WHERE version = '006_fast_stream_engine.sql'
       ) AS ready`
    );
    if (!migration.rows[0]?.ready) {
      const error = new Error('Application schema is not ready');
      error.statusCode = 503;
      throw error;
    }
    return { status: 'ready' };
  },
  streamHealth: async () => {
    const [queue, browser, providers, metrics, workers] = await Promise.all([
      db.query(
        `SELECT status, COUNT(*)::integer AS count
         FROM stream_resolution_jobs
         WHERE status IN ('pending', 'processing')
         GROUP BY status`
      ),
      db.query(
        `SELECT COUNT(*) FILTER (
           WHERE owner IS NOT NULL AND lease_expires_at > NOW()
         )::integer AS used
         FROM stream_browser_slots
         WHERE slot_number <= $1`,
        [browserLimit]
      ),
      db.query(
        `SELECT provider_id, success_count, failure_count, consecutive_failures,
                last_success_at, last_failure_at, circuit_open_until,
                CASE WHEN success_count + failure_count = 0 THEN 0
                     ELSE ROUND(total_resolution_ms::numeric /
                                (success_count + failure_count))::integer
                END AS avg_resolution_ms
         FROM stream_provider_health ORDER BY provider_id`
      ),
      db.query(
        `SELECT metric_name, metric_value, duration_total_ms, duration_count
         FROM stream_metrics ORDER BY metric_name`
      ),
      db.query(
        `SELECT COUNT(*)::integer AS active
         FROM stream_worker_heartbeats
         WHERE last_seen_at > NOW() - ($1::double precision * INTERVAL '1 second')`,
        [heartbeatSeconds * 2]
      ),
    ]);
    const queueCounts = { pending: 0, processing: 0 };
    for (const row of queue.rows) queueCounts[row.status] = row.count;
    return {
      queue: queueCounts,
      browser: { used: browser.rows[0]?.used || 0, limit: browserLimit },
      workers: { active: workers.rows[0]?.active || 0 },
      providers: providers.rows,
      metrics: Object.fromEntries(metrics.rows.map((row) => [
        row.metric_name,
        {
          value: Number(row.metric_value),
          duration_total_ms: Number(row.duration_total_ms),
          duration_count: Number(row.duration_count),
        },
      ])),
    };
  },
});

module.exports = { createHealthService };
