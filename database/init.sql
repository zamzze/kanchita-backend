\set ON_ERROR_STOP on

-- New development databases are assembled from the same versioned SQL files
-- used by the Node migration runner. The runner remains the canonical way to
-- upgrade existing databases and records applied versions in schema_migrations.
BEGIN;
\ir migrations/001_legacy_baseline.sql
\ir migrations/002_phase_1b_schema_alignment.sql
\ir migrations/003_auth_sessions.sql
\ir migrations/004_stream_lifecycle.sql
\ir migrations/005_stream_resolution_jobs.sql
\ir migrations/006_fast_stream_engine.sql
\ir migrations/007_safe_playback_headers.sql
\ir migrations/008_temporary_stream_urls.sql
\ir migrations/009_provider_media_mappings.sql
\ir migrations/010_bulk_ingestion_persistence.sql
COMMIT;
