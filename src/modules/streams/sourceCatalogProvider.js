'use strict';

const { createSourceCatalogStore } = require('../../db/sourceCatalog.queries');

const createSourceCatalogProvider = ({
  db,
  store = createSourceCatalogStore(db),
  resolveSource = null,
} = {}) => ({
  id: 'tutorial_catalog',
  strategy: 'direct',
  supportsMovies: true,
  supportsEpisodes: true,
  audioLanguages: ['unknown'],
  qualityHint: 'unknown',
  expensive: false,
  fallback: false,

  resolve: async (context) => {
    const sources = await store.findActiveMappedServers(
      context.contentType,
      context.contentId
    );

    if (!sources.length) {
      return {
        skip: true,
        reason: 'NO_CATALOG_SOURCES',
      };
    }

    if (typeof resolveSource !== 'function') {
      return {
        skip: true,
        reason: 'CATALOG_RESOLVER_NOT_CONFIGURED',
      };
    }

    for (const source of sources) {
      try {
        const result = await resolveSource({
          context,
          source: {
            id: source.catalog_source_id,
            catalogItemId: source.catalog_item_id,
            serverIndex: source.server_index,
            url: source.iframe_url,
            host: source.iframe_host,
            sourceType: source.source_type,
            providerId: source.provider_id,
            tmdbId: source.tmdb_id,
          },
        });

        if (result?.url) {
          return {
            ...result,
            serverName:
              result.serverName ||
              'Catalog ' + String(source.server_index),
          };
        }
      } catch {
        // A single catalog candidate must never block the fallback provider chain.
      }
    }

    return {
      skip: true,
      reason: 'NO_CATALOG_SOURCE_RESOLVED',
    };
  },
});

module.exports = {
  createSourceCatalogProvider,
};
