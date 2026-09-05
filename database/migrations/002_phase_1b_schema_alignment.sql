CREATE TABLE IF NOT EXISTS subtitles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(10) NOT NULL
    CHECK (content_type IN ('movie', 'episode')),
  content_id UUID NOT NULL,
  subtitle_url TEXT NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'es',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subtitles_content_language_unique
    UNIQUE (content_type, content_id, language)
);

CREATE INDEX IF NOT EXISTS idx_subtitles_active_lookup
  ON subtitles (content_type, content_id, language)
  WHERE is_active = TRUE;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'streams'::regclass
      AND conname = 'streams_content_server_unique'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM streams
      GROUP BY content_type, content_id, server_name
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION
        'Cannot add streams_content_server_unique: logical duplicate streams exist';
    END IF;

    ALTER TABLE streams
      ADD CONSTRAINT streams_content_server_unique
      UNIQUE NULLS NOT DISTINCT (content_type, content_id, server_name);
  END IF;
END
$migration$;
