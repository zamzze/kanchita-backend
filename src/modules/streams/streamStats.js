'use strict';

const pool = require('../../config/db');

const createStreamStatsStore = (db = pool) => ({
  recordRequest: (contentType, contentId) => db.query(
    `INSERT INTO stream_content_stats
       (content_type, content_id, request_count, last_requested_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (content_type, content_id) DO UPDATE SET
       request_count = stream_content_stats.request_count + 1,
       last_requested_at = NOW()`,
    [contentType, contentId]
  ),
  recordReady: (contentType, contentId, resolutionMs = null) => db.query(
    `INSERT INTO stream_content_stats
       (content_type, content_id, last_ready_at, last_resolution_ms)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (content_type, content_id) DO UPDATE SET
       last_ready_at = NOW(),
       last_resolution_ms = COALESCE(EXCLUDED.last_resolution_ms,
                                     stream_content_stats.last_resolution_ms)`,
    [contentType, contentId, resolutionMs]
  ),
  deferRefresh: (contentType, contentId, minutes = 10) => db.query(
    `INSERT INTO stream_content_stats
       (content_type, content_id, refresh_not_before)
     VALUES ($1, $2, NOW() + ($3::double precision * INTERVAL '1 minute'))
     ON CONFLICT (content_type, content_id) DO UPDATE SET
       refresh_not_before = EXCLUDED.refresh_not_before`,
    [contentType, contentId, minutes]
  ),
});

module.exports = { createStreamStatsStore };
