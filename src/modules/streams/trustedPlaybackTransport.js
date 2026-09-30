'use strict';

const { loadResolverV2Catalog } = require('./resolverV2/catalog/catalogLoader');
const { HLS_PROXY_MODES } = require('./hlsProxyToken');
const {
  STREAM_RESOLVER_V2_CATALOG_ENABLED,
  STREAM_RESOLVER_V2_CATALOG_PATH,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED,
  STREAM_RESOLVER_V2_HTTP_PROVIDER_ID,
  PLUTO_ENABLED,
} = require('../../config/env');

// Only the server-owned catalog can opt an exact-mapping provider into the
// relaxed transport. Neither provider_sources nor stream metadata is consulted.
const createTrustedPlaybackModeForStream = (catalog, { reservedProviderIds = [] } = {}) => {
  const optedIn = new Set();
  const reserved = new Set(reservedProviderIds.map((id) =>
    typeof id === 'string' ? id.trim().toLowerCase() : id));
  if (catalog?.loaded === true && Array.isArray(catalog.sources)) {
    for (const source of catalog.sources) {
      if (source.type === 'persisted_sources' && source.enabled === true &&
          source.hlsProxyMode === HLS_PROXY_MODES.PLAYLISTS_ONLY &&
          !reserved.has(source.id)) {
        optedIn.add(source.id);
      }
    }
  }
  return (stream) => stream?.stream_type === 'direct' &&
    optedIn.has(stream?.provider) ? HLS_PROXY_MODES.PLAYLISTS_ONLY : HLS_PROXY_MODES.FULL;
};

const loadTrustedPlaybackModeForStream = ({
  enabled = STREAM_RESOLVER_V2_CATALOG_ENABLED,
  filePath = STREAM_RESOLVER_V2_CATALOG_PATH,
  catalogLoader = loadResolverV2Catalog,
  reservedProviderIds = [
    ...(PLUTO_ENABLED ? ['pluto'] : []),
    ...(STREAM_RESOLVER_V2_HTTP_PROVIDER_ENABLED
      ? [STREAM_RESOLVER_V2_HTTP_PROVIDER_ID] : []),
  ],
} = {}) => createTrustedPlaybackModeForStream(catalogLoader({ enabled, filePath }),
  { reservedProviderIds });

module.exports = { createTrustedPlaybackModeForStream, loadTrustedPlaybackModeForStream };
