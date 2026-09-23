-- Preserve existing movie/episode mappings while admitting show-level identities.
ALTER TABLE provider_media_mappings
  DROP CONSTRAINT provider_media_mappings_content_type_check,
  DROP CONSTRAINT provider_media_mappings_episode_identity_check;

ALTER TABLE provider_media_mappings
  ADD CONSTRAINT provider_media_mappings_content_type_check
    CHECK (content_type IN ('movie', 'series', 'episode')),
  ADD CONSTRAINT provider_media_mappings_episode_identity_check CHECK (
    (content_type IN ('movie', 'series')
      AND season_number IS NULL AND episode_number IS NULL)
    OR (content_type = 'episode' AND season_number IS NOT NULL
      AND season_number >= 0 AND episode_number IS NOT NULL AND episode_number > 0)
  );

-- Bulk mapping runs need a distinct show-level item without treating it as an episode.
ALTER TABLE ingestion_run_items
  ADD COLUMN series_id UUID REFERENCES series(id) ON DELETE RESTRICT;
ALTER TABLE ingestion_run_items
  DROP CONSTRAINT ingestion_run_items_identity_check;
ALTER TABLE ingestion_run_items
  ADD CONSTRAINT ingestion_run_items_identity_check
    CHECK (num_nonnulls(movie_id, series_id, episode_id) = 1);
CREATE UNIQUE INDEX ingestion_run_items_series_unique
  ON ingestion_run_items (run_id, series_id) WHERE series_id IS NOT NULL;
