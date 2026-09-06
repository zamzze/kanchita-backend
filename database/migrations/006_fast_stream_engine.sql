ALTER TABLE stream_resolution_jobs
  ADD COLUMN priority SMALLINT NOT NULL DEFAULT 50,
  ADD COLUMN job_type VARCHAR(20) NOT NULL DEFAULT 'resolve',
  ADD CONSTRAINT stream_resolution_jobs_priority_check CHECK (priority BETWEEN 0 AND 100),
  ADD CONSTRAINT stream_resolution_jobs_job_type_check CHECK (job_type IN ('resolve', 'refresh'));

DROP INDEX stream_resolution_jobs_claim_idx;
CREATE INDEX stream_resolution_jobs_claim_idx
  ON stream_resolution_jobs (priority DESC, run_after ASC, created_at ASC)
  WHERE status = 'pending';

ALTER TABLE streams
  ADD COLUMN audio_language VARCHAR(10),
  ADD COLUMN subtitle_language VARCHAR(10),
  ADD COLUMN cleanliness VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT streams_cleanliness_check CHECK (cleanliness IN ('clean', 'unknown', 'ad_marked'));

UPDATE streams
SET audio_language = CASE WHEN language = 'en-sub' THEN 'en' ELSE language END,
    subtitle_language = CASE WHEN language = 'en-sub' THEN 'es' ELSE NULL END
WHERE audio_language IS NULL;

CREATE TABLE stream_content_stats (
  content_type VARCHAR(10) NOT NULL,
  content_id UUID NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_requested_at TIMESTAMPTZ,
  last_ready_at TIMESTAMPTZ,
  last_resolution_ms INTEGER CHECK (last_resolution_ms IS NULL OR last_resolution_ms >= 0),
  refresh_not_before TIMESTAMPTZ,
  PRIMARY KEY (content_type, content_id),
  CONSTRAINT stream_content_stats_type_check CHECK (content_type IN ('movie', 'episode'))
);

CREATE INDEX stream_content_stats_popular_idx
  ON stream_content_stats (request_count DESC, last_requested_at DESC);

CREATE INDEX streams_refresh_ahead_idx
  ON streams (expires_at)
  WHERE is_active = TRUE AND status = 'ready';

CREATE TABLE stream_provider_health (
  provider_id VARCHAR(100) PRIMARY KEY,
  success_count BIGINT NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_resolution_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_resolution_ms >= 0),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  circuit_open_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stream_browser_slots (
  slot_number INTEGER PRIMARY KEY CHECK (slot_number > 0),
  owner VARCHAR(200),
  acquired_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  CONSTRAINT stream_browser_slots_lease_check CHECK (
    (owner IS NULL AND acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (owner IS NOT NULL AND acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX stream_browser_slots_lease_idx
  ON stream_browser_slots (lease_expires_at) WHERE owner IS NOT NULL;

CREATE TABLE stream_worker_heartbeats (
  worker_id VARCHAR(200) PRIMARY KEY,
  worker_type VARCHAR(40) NOT NULL DEFAULT 'stream',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_job UUID,
  CONSTRAINT stream_worker_heartbeats_type_check CHECK (worker_type = 'stream')
);

CREATE INDEX stream_worker_heartbeats_seen_idx
  ON stream_worker_heartbeats (last_seen_at DESC);

CREATE TABLE stream_metrics (
  metric_name VARCHAR(100) PRIMARY KEY,
  metric_value BIGINT NOT NULL DEFAULT 0 CHECK (metric_value >= 0),
  duration_total_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_total_ms >= 0),
  duration_count BIGINT NOT NULL DEFAULT 0 CHECK (duration_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stream_browser_slots (slot_number) VALUES (1);

ALTER TABLE stream_resolution_jobs
  DROP CONSTRAINT stream_resolution_jobs_last_error_code_check,
  ADD CONSTRAINT stream_resolution_jobs_last_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'RESOLUTION_FAILED', 'RESOLUTION_TIMEOUT', 'BROWSER_CAPACITY_UNAVAILABLE',
      'HLS_TIMEOUT', 'HLS_HTTP_ERROR', 'HLS_INVALID_URL',
      'HLS_TOO_MANY_REDIRECTS', 'HLS_TOO_LARGE', 'HLS_INVALID_MANIFEST',
      'HLS_CONNECTION_ERROR', 'HLS_UNSAFE_DESTINATION',
      'JOB_LEASE_EXPIRED', 'INTERNAL_JOB_ERROR'
    )
  );

ALTER TABLE streams
  DROP CONSTRAINT streams_last_error_code_check,
  ADD CONSTRAINT streams_last_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'HLS_TIMEOUT', 'HLS_HTTP_ERROR', 'HLS_INVALID_URL',
      'HLS_TOO_MANY_REDIRECTS', 'HLS_TOO_LARGE', 'HLS_INVALID_MANIFEST',
      'HLS_CONNECTION_ERROR', 'HLS_UNSAFE_DESTINATION',
      'RESOLUTION_FAILED', 'RESOLUTION_TIMEOUT', 'BROWSER_CAPACITY_UNAVAILABLE'
    )
  );
