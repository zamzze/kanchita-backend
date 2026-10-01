'use strict';

const pool = require('../config/db');

const createSourceCatalogStore = (db = pool) => {
  const upsertItemWithClient = async (client, item) => {
    const { rows } = await client.query(
      `INSERT INTO source_catalog_items (
         provider_id, tutorial_url, request_url_used, fetch_status,
         server_count, last_seen_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT source_catalog_items_provider_url_unique
       DO UPDATE SET
         request_url_used = EXCLUDED.request_url_used,
         fetch_status = EXCLUDED.fetch_status,
         server_count = EXCLUDED.server_count,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id, match_status, mapped_content_type, mapped_content_id, tmdb_id`,
      [
        item.provider_id,
        item.tutorial_url,
        item.request_url_used || null,
        item.fetch_status,
        item.server_count || 0,
      ]
    );
    return rows[0];
  };

  const deactivateServersWithClient = (client, catalogItemId) =>
    client.query(
      `UPDATE source_catalog_servers
       SET is_active = FALSE, updated_at = NOW()
       WHERE catalog_item_id = $1 AND is_active = TRUE`,
      [catalogItemId]
    );

  const upsertServerWithClient = async (client, server) => {
    const { rows } = await client.query(
      `INSERT INTO source_catalog_servers (
         catalog_item_id, server_index, iframe_url, iframe_host,
         source_type, is_active, last_seen_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'embed', TRUE, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT source_catalog_servers_item_url_unique
       DO UPDATE SET
         server_index = EXCLUDED.server_index,
         iframe_host = EXCLUDED.iframe_host,
         is_active = TRUE,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [
        server.catalog_item_id,
        server.server_index,
        server.iframe_url,
        server.iframe_host || null,
      ]
    );
    return rows[0];
  };

  const findActiveMappedServers = async (contentType, contentId) => {
    const { rows } = await db.query(
      `SELECT
         scs.id AS catalog_source_id,
         scs.catalog_item_id,
         scs.server_index,
         scs.iframe_url,
         scs.iframe_host,
         scs.source_type,
         sci.provider_id,
         sci.tmdb_id
       FROM source_catalog_items sci
       JOIN source_catalog_servers scs
         ON scs.catalog_item_id = sci.id
       WHERE sci.fetch_status = 'ok'
         AND sci.match_status = 'matched'
         AND sci.mapped_content_type = $1
         AND sci.mapped_content_id = $2
         AND scs.is_active = TRUE
       ORDER BY scs.server_index ASC, scs.id ASC`,
      [contentType, contentId]
    );
    return rows;
  };

  const getImportSummary = async () => {
    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int AS items,
         COUNT(*) FILTER (WHERE fetch_status = 'ok')::int AS ok_items,
         COUNT(*) FILTER (WHERE fetch_status = 'no_servers')::int AS no_server_items,
         COUNT(*) FILTER (WHERE fetch_status = 'not_found_404')::int AS not_found_items,
         COUNT(*) FILTER (WHERE match_status = 'unmapped')::int AS unmapped_items,
         (SELECT COUNT(*)::int FROM source_catalog_servers WHERE is_active = TRUE)
           AS active_servers
       FROM source_catalog_items`
    );
    return rows[0];
  };

  return {
    upsertItemWithClient,
    deactivateServersWithClient,
    upsertServerWithClient,
    findActiveMappedServers,
    getImportSummary,
  };
};

module.exports = {
  createSourceCatalogStore,
  ...createSourceCatalogStore(),
};
