CREATE TABLE source_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id VARCHAR(100) NOT NULL,
  tutorial_url TEXT NOT NULL,
  request_url_used TEXT,
  fetch_status VARCHAR(30) NOT NULL,
  match_status VARCHAR(20) NOT NULL DEFAULT 'unmapped',
  mapped_content_type VARCHAR(10),
  mapped_content_id UUID,
  tmdb_id INT,
  server_count INTEGER NOT NULL DEFAULT 0,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT source_catalog_items_provider_url_unique
    UNIQUE (provider_id, tutorial_url),
  CONSTRAINT source_catalog_items_fetch_status_check
    CHECK (fetch_status IN (
      'ok', 'no_servers', 'not_found_404',
      'http_error', 'network_error', 'unexpected_content_type'
    )),
  CONSTRAINT source_catalog_items_match_status_check
    CHECK (match_status IN ('unmapped', 'matched', 'ambiguous', 'ignored')),
  CONSTRAINT source_catalog_items_content_type_check
    CHECK (mapped_content_type IS NULL OR mapped_content_type IN ('movie', 'episode')),
  CONSTRAINT source_catalog_items_mapping_pair_check
    CHECK (
      (mapped_content_type IS NULL AND mapped_content_id IS NULL)
      OR (mapped_content_type IS NOT NULL AND mapped_content_id IS NOT NULL)
    ),
  CONSTRAINT source_catalog_items_server_count_check
    CHECK (server_count >= 0)
);

CREATE TABLE source_catalog_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL
    REFERENCES source_catalog_items(id) ON DELETE CASCADE,
  server_index SMALLINT NOT NULL,
  iframe_url TEXT NOT NULL,
  iframe_host VARCHAR(255),
  source_type VARCHAR(20) NOT NULL DEFAULT 'embed',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT source_catalog_servers_item_url_unique
    UNIQUE (catalog_item_id, iframe_url),
  CONSTRAINT source_catalog_servers_index_check
    CHECK (server_index > 0),
  CONSTRAINT source_catalog_servers_type_check
    CHECK (source_type = 'embed')
);

CREATE INDEX source_catalog_items_match_idx
  ON source_catalog_items (match_status, provider_id);

CREATE INDEX source_catalog_items_mapped_content_idx
  ON source_catalog_items (mapped_content_type, mapped_content_id)
  WHERE mapped_content_id IS NOT NULL;

CREATE INDEX source_catalog_items_tmdb_idx
  ON source_catalog_items (tmdb_id)
  WHERE tmdb_id IS NOT NULL;

CREATE INDEX source_catalog_servers_active_idx
  ON source_catalog_servers (catalog_item_id, server_index)
  WHERE is_active = TRUE;

CREATE INDEX source_catalog_servers_host_idx
  ON source_catalog_servers (iframe_host)
  WHERE is_active = TRUE;
