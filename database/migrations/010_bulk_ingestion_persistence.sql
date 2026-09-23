-- movies, series and episodes remain the canonical catalog; 009 owns mappings.
-- These tables are a separate ingestion ledger, not the authoritative playback cache.
CREATE TABLE provider_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id BIGINT NOT NULL REFERENCES provider_media_mappings(id) ON DELETE CASCADE,
  source_key CHAR(64) NOT NULL,
  source_url TEXT NOT NULL,
  source_type VARCHAR(20) NOT NULL,
  resolver_id VARCHAR(128),
  language VARCHAR(32),
  quality VARCHAR(32),
  headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_sources_key_unique UNIQUE (mapping_id, source_key),
  CONSTRAINT provider_sources_key_check CHECK (source_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT provider_sources_type_check CHECK (source_type IN ('embed', 'direct_hls', 'direct_mp4', 'api')),
  CONSTRAINT provider_sources_status_check CHECK (status IN ('active', 'stale', 'broken', 'refresh_required', 'disabled')),
  CONSTRAINT provider_sources_failure_check CHECK (failure_count >= 0),
  CONSTRAINT provider_sources_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT provider_sources_headers_check CHECK (
    jsonb_typeof(headers_json) = 'object' AND
    headers_json - ARRAY['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'range'] = '{}'::jsonb
  ),
  CONSTRAINT provider_sources_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX provider_sources_active_idx ON provider_sources (mapping_id, discovered_at DESC)
  WHERE status = 'active';
CREATE INDEX provider_sources_status_idx ON provider_sources (status, updated_at);

CREATE TABLE resolved_stream_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES provider_sources(id) ON DELETE CASCADE,
  stream_key CHAR(64) NOT NULL,
  variant_key VARCHAR(128) NOT NULL DEFAULT '',
  stream_url TEXT,
  protocol VARCHAR(10) NOT NULL,
  quality VARCHAR(32),
  language VARCHAR(32),
  headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  url_sensitivity VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  validated_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resolved_stream_cache_key_unique UNIQUE (source_id, stream_key),
  CONSTRAINT resolved_stream_cache_key_check CHECK (stream_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT resolved_stream_cache_protocol_check CHECK (protocol IN ('hls', 'mp4', 'dash')),
  CONSTRAINT resolved_stream_cache_status_check CHECK (status IN ('active', 'stale', 'broken', 'expired', 'refresh_required', 'disabled')),
  CONSTRAINT resolved_stream_cache_sensitivity_check CHECK (url_sensitivity IN ('normal', 'temporary_signed')),
  CONSTRAINT resolved_stream_cache_expiry_check CHECK (url_sensitivity <> 'temporary_signed' OR expires_at IS NOT NULL),
  CONSTRAINT resolved_stream_cache_active_url_check CHECK (status <> 'active' OR stream_url IS NOT NULL),
  CONSTRAINT resolved_stream_cache_failure_check CHECK (failure_count >= 0),
  CONSTRAINT resolved_stream_cache_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT resolved_stream_cache_headers_check CHECK (
    jsonb_typeof(headers_json) = 'object' AND
    headers_json - ARRAY['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'range'] = '{}'::jsonb
  ),
  CONSTRAINT resolved_stream_cache_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX resolved_stream_cache_usable_idx ON resolved_stream_cache (source_id, expires_at)
  WHERE status = 'active' AND validated_at IS NOT NULL;
CREATE INDEX resolved_stream_cache_status_idx ON resolved_stream_cache (status, updated_at);

CREATE TABLE ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  requested_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  mapped_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  validated_stream_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingestion_runs_type_check CHECK (run_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ingestion_runs_status_check CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ingestion_runs_counts_check CHECK (
    requested_count >= 0 AND processed_count >= 0 AND mapped_count >= 0 AND
    source_count >= 0 AND validated_stream_count >= 0 AND failed_count >= 0
  ),
  CONSTRAINT ingestion_runs_json_check CHECK (jsonb_typeof(checkpoint_json) = 'object' AND jsonb_typeof(config_json) = 'object'),
  CONSTRAINT ingestion_runs_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
CREATE INDEX ingestion_runs_status_idx ON ingestion_runs (status, created_at);

CREATE TABLE ingestion_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  movie_id UUID REFERENCES movies(id) ON DELETE RESTRICT,
  episode_id UUID REFERENCES episodes(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  mapping_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  stream_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingestion_run_items_identity_check CHECK ((movie_id IS NOT NULL) <> (episode_id IS NOT NULL)),
  CONSTRAINT ingestion_run_items_status_check CHECK (status IN ('pending', 'processing', 'completed', 'no_mapping', 'no_source', 'failed', 'skipped')),
  CONSTRAINT ingestion_run_items_counts_check CHECK (attempt_count >= 0 AND mapping_count >= 0 AND source_count >= 0 AND stream_count >= 0),
  CONSTRAINT ingestion_run_items_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
CREATE UNIQUE INDEX ingestion_run_items_movie_unique ON ingestion_run_items (run_id, movie_id)
  WHERE movie_id IS NOT NULL;
CREATE UNIQUE INDEX ingestion_run_items_episode_unique ON ingestion_run_items (run_id, episode_id)
  WHERE episode_id IS NOT NULL;
CREATE INDEX ingestion_run_items_claim_idx ON ingestion_run_items (run_id, created_at, id)
  WHERE status = 'pending';
CREATE INDEX ingestion_run_items_processing_idx ON ingestion_run_items (run_id, started_at)
  WHERE status = 'processing';
