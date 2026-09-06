'use strict';

const STRATEGIES = new Set(['direct', 'browser']);

const validateProvider = (provider) => {
  if (!provider || !/^[a-z0-9_]+$/.test(provider.id || '')) {
    throw new Error('Invalid stream provider id');
  }
  if (!STRATEGIES.has(provider.strategy) || typeof provider.resolve !== 'function') {
    throw new Error('Invalid stream provider contract');
  }
  return Object.freeze({
    supportsMovies: true,
    supportsEpisodes: true,
    audioLanguages: ['unknown'],
    qualityHint: 'unknown',
    expensive: provider.strategy === 'browser',
    fallback: provider.strategy === 'browser',
    ...provider,
    requiresBrowser: provider.strategy === 'browser',
  });
};

const createProviderRegistry = (providers = []) => {
  const entries = providers.map(validateProvider);
  const ids = new Set(entries.map(({ id }) => id));
  if (ids.size !== entries.length) throw new Error('Duplicate stream provider id');
  return {
    all: () => [...entries],
    compatible: (contentType) => entries.filter((provider) =>
      contentType === 'movie' ? provider.supportsMovies : provider.supportsEpisodes
    ),
    get: (id) => entries.find((provider) => provider.id === id) || null,
  };
};

module.exports = { STRATEGIES, createProviderRegistry, validateProvider };
