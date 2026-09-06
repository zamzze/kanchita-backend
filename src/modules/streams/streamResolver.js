'use strict';

const { getStreamFromCineby } = require('../../ingestion/scraper/providers/providerC');

// Adapter only: the existing provider implementation remains unchanged.
const resolveStream = async ({ contentType, tmdbId, season, episode }) => {
  const url = await getStreamFromCineby(
    tmdbId,
    contentType === 'episode' ? 'tv' : 'movie',
    season,
    episode
  );

  return url ? {
    url,
    provider: 'provider_c',
    expiresAt: null,
    serverName: 'HD',
    quality: 'auto',
    language: 'en-sub',
  } : null;
};

module.exports = { resolveStream };
