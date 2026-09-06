'use strict';

const pool = require('../../config/db');

const createWorkerHeartbeatStore = (db = pool) => ({
  start: (workerId) => db.query(
    `INSERT INTO stream_worker_heartbeats
       (worker_id, worker_type, started_at, last_seen_at, active_job)
     VALUES ($1, 'stream', NOW(), NOW(), NULL)
     ON CONFLICT (worker_id) DO UPDATE SET
       started_at = NOW(), last_seen_at = NOW(), active_job = NULL`,
    [workerId]
  ),
  beat: (workerId, activeJob = null) => db.query(
    `UPDATE stream_worker_heartbeats
     SET last_seen_at = NOW(), active_job = $2 WHERE worker_id = $1`,
    [workerId, activeJob]
  ),
  stop: (workerId) => db.query(
    'DELETE FROM stream_worker_heartbeats WHERE worker_id = $1',
    [workerId]
  ),
});

module.exports = { createWorkerHeartbeatStore };
