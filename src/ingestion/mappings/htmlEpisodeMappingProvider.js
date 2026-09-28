'use strict';

const { createHtmlEpisodeMappingDiscovery } = require('./htmlEpisodeDiscovery');

const createHtmlEpisodeMappingProvider = ({
  id, region, baseUrl, seriesPathTemplate, http, mappingStore,
  maxSeasons, maxEpisodesPerSeason, timeoutMs,
} = {}) => {
  if (!mappingStore || typeof mappingStore.findActiveMapping !== 'function') {
    throw new Error('HTML_EPISODE_MAPPING_INVALID_STORE');
  }
  const discoverer = createHtmlEpisodeMappingDiscovery({
    providerId: id, region, baseUrl, seriesPathTemplate, http,
    maxSeasons, maxEpisodesPerSeason, timeoutMs,
  });
  return Object.freeze({
    id, enabled: true, priority: 100, region,
    supportsMovies: false, supportsSeries: true,
    maxConcurrent: 1, minDelayMs: 0,
    discoverMapping: async () => [],
    discoverSeriesEpisodes: async (media) => {
      if (media?.contentType !== 'series') return [];
      const root = await mappingStore.findActiveMapping({
        providerId: id, region, contentType: 'series', tmdbId: media.tmdbId,
      });
      const externalId = root?.external_id;
      if (typeof externalId !== 'string' || !externalId) return [];
      return discoverer.discover({ series: media, externalId });
    },
  });
};

module.exports = { createHtmlEpisodeMappingProvider };
