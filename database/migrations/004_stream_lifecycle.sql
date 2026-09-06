ALTER TABLE streams
  ADD COLUMN provider VARCHAR(100),
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN last_verified_at TIMESTAMPTZ,
  ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_failure_at TIMESTAMPTZ,
  ADD COLUMN next_retry_at TIMESTAMPTZ,
  ADD COLUMN last_error_code VARCHAR(40),
  ADD CONSTRAINT streams_status_check
    CHECK (status IN ('unknown', 'ready', 'stale', 'failed')),
  ADD CONSTRAINT streams_failure_count_check
    CHECK (failure_count >= 0),
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
        'RESOLUTION_FAILED'
      )
    );

CREATE INDEX streams_lifecycle_lookup_idx
  ON streams (content_type, content_id, status, is_active);

CREATE INDEX streams_retry_idx
  ON streams (next_retry_at)
  WHERE status = 'failed' AND is_active = TRUE;

-- Existing rows intentionally remain unknown and unverified. They are preserved
-- and evaluated lazily on first access; migrations never contact remote hosts.
