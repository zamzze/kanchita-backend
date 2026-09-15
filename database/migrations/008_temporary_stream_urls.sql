ALTER TABLE streams
  ADD COLUMN url_sensitivity VARCHAR(32) NOT NULL DEFAULT 'normal',
  ADD CONSTRAINT streams_url_sensitivity_check
    CHECK (url_sensitivity IN ('normal', 'temporary_signed')),
  ADD CONSTRAINT streams_temporary_url_expiry_check
    CHECK (url_sensitivity <> 'temporary_signed' OR expires_at IS NOT NULL);

-- Signed URLs remain the short-lived playback hand-off between worker and API.
-- Application lifecycle code clears them when they become stale or enter the
-- safety window; the query string is never copied into diagnostics or errors.
