CREATE TABLE stream_resolution_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(10) NOT NULL,
  content_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(200),
  last_error_code VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT stream_resolution_jobs_content_type_check
    CHECK (content_type IN ('movie', 'episode')),
  CONSTRAINT stream_resolution_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT stream_resolution_jobs_attempt_count_check
    CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  CONSTRAINT stream_resolution_jobs_max_attempts_check
    CHECK (max_attempts > 0),
  CONSTRAINT stream_resolution_jobs_lock_check
    CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
      OR
      (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
    ),
  CONSTRAINT stream_resolution_jobs_last_error_code_check
    CHECK (
      last_error_code IS NULL OR last_error_code IN (
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
        'INTERNAL_JOB_ERROR'
      )
    )
);

CREATE UNIQUE INDEX stream_resolution_jobs_active_content_idx
  ON stream_resolution_jobs (content_type, content_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX stream_resolution_jobs_claim_idx
  ON stream_resolution_jobs (run_after, created_at)
  WHERE status = 'pending';

CREATE INDEX stream_resolution_jobs_lease_idx
  ON stream_resolution_jobs (locked_at)
  WHERE status = 'processing';

ALTER TABLE streams
  DROP CONSTRAINT streams_last_error_code_check,
  ADD CONSTRAINT streams_last_error_code_check
    CHECK (
      last_error_code IS NULL OR last_error_code IN (
        'HLS_INVALID_URL',
        'HLS_TIMEOUT',
        'HLS_HTTP_ERROR',
        'HLS_TOO_MANY_REDIRECTS',
        'HLS_TOO_LARGE',
        'HLS_INVALID_MANIFEST',
        'HLS_CONNECTION_ERROR',
        'HLS_UNSAFE_DESTINATION',
        'RESOLUTION_FAILED',
        'RESOLUTION_TIMEOUT'
      )
    );
