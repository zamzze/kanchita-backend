ALTER TABLE streams
  ADD COLUMN playback_headers JSONB,
  ADD CONSTRAINT streams_playback_headers_check CHECK (
    playback_headers IS NULL OR (
      jsonb_typeof(playback_headers) = 'object'
      AND playback_headers - ARRAY['referer', 'origin'] = '{}'::jsonb
      AND (NOT (playback_headers ? 'referer')
        OR jsonb_typeof(playback_headers -> 'referer') = 'string')
      AND (NOT (playback_headers ? 'origin')
        OR jsonb_typeof(playback_headers -> 'origin') = 'string')
    )
  );

-- Existing streams remain headerless. Values are only written after application-level
-- URL and CR/LF validation against the closed Referer/Origin allowlist.
