CREATE TABLE provider_media_mappings (
  id BIGSERIAL PRIMARY KEY,
  provider_id VARCHAR(128) NOT NULL,
  region VARCHAR(32) NOT NULL,
  content_type VARCHAR(16) NOT NULL,
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER,
  episode_number INTEGER,
  external_id VARCHAR(256) NOT NULL,
  provider_title VARCHAR(512),
  provider_slug VARCHAR(512),
  match_method VARCHAR(64),
  match_confidence NUMERIC(5,2),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_media_mappings_content_type_check
    CHECK (content_type IN ('movie', 'episode')),
  CONSTRAINT provider_media_mappings_status_check
    CHECK (status IN ('active', 'inactive', 'review')),
  CONSTRAINT provider_media_mappings_tmdb_id_check CHECK (tmdb_id > 0),
  CONSTRAINT provider_media_mappings_episode_identity_check CHECK (
    (content_type = 'movie' AND season_number IS NULL AND episode_number IS NULL)
    OR
    (content_type = 'episode' AND season_number IS NOT NULL AND season_number >= 0
      AND episode_number IS NOT NULL AND episode_number > 0)
  ),
  CONSTRAINT provider_media_mappings_match_confidence_check
    CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 100)),
  CONSTRAINT provider_media_mappings_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT provider_media_mappings_external_identity_unique
    UNIQUE (provider_id, region, content_type, external_id)
);

CREATE INDEX provider_media_mappings_lookup_idx
  ON provider_media_mappings
    (provider_id, region, content_type, tmdb_id, status);

CREATE INDEX provider_media_mappings_episode_lookup_idx
  ON provider_media_mappings
    (provider_id, region, tmdb_id, season_number, episode_number, status)
  WHERE content_type = 'episode';
