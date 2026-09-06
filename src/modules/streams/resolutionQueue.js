'use strict';

const pool = require('../../config/db');

const JOB_ERROR_CODES = new Set([
  'RESOLUTION_FAILED',
  'RESOLUTION_TIMEOUT',
  'HLS_TIMEOUT',
  'HLS_HTTP_ERROR',
  'HLS_INVALID_URL',
  'HLS_TOO_MANY_REDIRECTS',
  'HLS_TOO_LARGE',
  'HLS_INVALID_MANIFEST',
  'HLS_CONNECTION_ERROR',
  'HLS_UNSAFE_DESTINATION',
  'JOB_LEASE_EXPIRED',
  'INTERNAL_JOB_ERROR',
]);

const safeErrorCode = (code) => JOB_ERROR_CODES.has(code)
  ? code
  : 'INTERNAL_JOB_ERROR';

const jobColumns = `
  id, content_type, content_id, status, attempt_count, max_attempts,
  run_after, locked_at, locked_by, last_error_code, created_at,
  updated_at, started_at, completed_at, priority, job_type`;

const claimedJobColumns = `
  jobs.id, jobs.content_type, jobs.content_id, jobs.status,
  jobs.attempt_count, jobs.max_attempts, jobs.run_after, jobs.locked_at,
  jobs.locked_by, jobs.last_error_code, jobs.created_at, jobs.updated_at,
  jobs.started_at, jobs.completed_at, jobs.priority, jobs.job_type`;

const retryDelaySql = `CASE
  WHEN attempt_count <= 1 THEN INTERVAL '30 seconds'
  WHEN attempt_count = 2 THEN INTERVAL '2 minutes'
  ELSE INTERVAL '5 minutes'
END`;

const createResolutionQueue = (db = pool, { maxAttempts = 3 } = {}) => {
  const enqueue = async (contentType, contentId, {
    priority = 50,
    jobType = 'resolve',
  } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO stream_resolution_jobs (
         content_type, content_id, status, max_attempts, run_after, priority, job_type
       ) VALUES ($1, $2, 'pending', $3, NOW(), $4, $5)
       ON CONFLICT (content_type, content_id)
         WHERE status IN ('pending', 'processing')
       DO UPDATE SET
         priority = GREATEST(stream_resolution_jobs.priority, EXCLUDED.priority),
         job_type = CASE
           WHEN stream_resolution_jobs.job_type = 'refresh' OR EXCLUDED.job_type = 'refresh'
             THEN 'refresh'
           ELSE 'resolve'
         END,
         updated_at = NOW()
       RETURNING ${jobColumns}`,
      [contentType, contentId, maxAttempts, priority, jobType]
    );
    return rows[0];
  };

  const findActiveJob = async (contentType, contentId) => {
    const { rows } = await db.query(
      `SELECT ${jobColumns}
       FROM stream_resolution_jobs
       WHERE content_type = $1 AND content_id = $2
         AND status IN ('pending', 'processing')
       LIMIT 1`,
      [contentType, contentId]
    );
    return rows[0] || null;
  };

  const claimNextJob = async (workerId) => {
    const { rows } = await db.query(
      `WITH candidate AS (
         SELECT id
         FROM stream_resolution_jobs
         WHERE status = 'pending'
           AND run_after <= NOW()
           AND attempt_count < max_attempts
         ORDER BY priority DESC, run_after ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE stream_resolution_jobs AS jobs
       SET status = 'processing',
           attempt_count = jobs.attempt_count + 1,
           locked_at = NOW(),
           locked_by = $1,
           started_at = COALESCE(jobs.started_at, NOW()),
           updated_at = NOW()
       FROM candidate
       WHERE jobs.id = candidate.id
       RETURNING ${claimedJobColumns}`,
      [workerId]
    );
    return rows[0] || null;
  };

  const completeJob = async (jobId, workerId) => {
    const { rows } = await db.query(
      `UPDATE stream_resolution_jobs
       SET status = 'completed',
           locked_at = NULL,
           locked_by = NULL,
           last_error_code = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING ${jobColumns}`,
      [jobId, workerId]
    );
    return rows[0] || null;
  };

  const failJob = async (jobId, workerId, errorCode, { terminal = false } = {}) => {
    const { rows } = await db.query(
      `UPDATE stream_resolution_jobs
       SET status = CASE
             WHEN $4::boolean OR attempt_count >= max_attempts THEN 'failed'
             ELSE 'pending'
           END,
           run_after = CASE
             WHEN $4::boolean OR attempt_count >= max_attempts THEN run_after
             ELSE NOW() + ${retryDelaySql}
           END,
           locked_at = NULL,
           locked_by = NULL,
           last_error_code = $3,
           completed_at = CASE
             WHEN $4::boolean OR attempt_count >= max_attempts THEN NOW()
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING ${jobColumns}`,
      [jobId, workerId, safeErrorCode(errorCode), terminal]
    );
    return rows[0] || null;
  };

  const recoverStaleJobs = async (leaseSeconds) => {
    const { rows } = await db.query(
      `UPDATE stream_resolution_jobs
       SET status = CASE
             WHEN attempt_count >= max_attempts THEN 'failed'
             ELSE 'pending'
           END,
           run_after = CASE
             WHEN attempt_count >= max_attempts THEN run_after
             ELSE NOW() + ${retryDelaySql}
           END,
           locked_at = NULL,
           locked_by = NULL,
           last_error_code = 'JOB_LEASE_EXPIRED',
           completed_at = CASE
             WHEN attempt_count >= max_attempts THEN NOW()
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE status = 'processing'
         AND locked_at < NOW() - ($1::double precision * INTERVAL '1 second')
       RETURNING ${jobColumns}`,
      [leaseSeconds]
    );
    return rows;
  };

  return {
    enqueue,
    findActiveJob,
    claimNextJob,
    completeJob,
    failJob,
    recoverStaleJobs,
  };
};

module.exports = {
  JOB_ERROR_CODES,
  safeErrorCode,
  createResolutionQueue,
};
