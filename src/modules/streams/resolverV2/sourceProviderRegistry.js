'use strict';

const { normalizeMediaContext } = require('./resolverContracts');
const { SOURCE_PROVIDER_ERROR_CODES, sourceProviderError } = require('./sourceProviderErrors');

const SOURCE_STRATEGIES = Object.freeze(['http', 'static', 'legacy']);
const strategies = new Set(SOURCE_STRATEGIES);
const MAX_TIMEOUT_MS = 120_000;
const MAX_CANDIDATES = 100;

const normalizeLanguages = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const output = [];
  const seen = new Set();
  for (const language of value) {
    if (typeof language !== 'string') return null;
    const normalized = language.trim();
    if (!normalized || normalized.length > 64) return null;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
};

const normalizeSourceProvider = (provider) => {
  const descriptor = provider?.descriptor;
  const id = typeof descriptor?.id === 'string' ? descriptor.id.trim().toLowerCase() : '';
  const languages = normalizeLanguages(descriptor?.languages);
  if (!provider || typeof provider !== 'object' || !descriptor ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof descriptor.active !== 'boolean' || !Number.isInteger(descriptor.priority) ||
      Math.abs(descriptor.priority) > 1_000_000 ||
      typeof descriptor.supportsMovies !== 'boolean' ||
      typeof descriptor.supportsEpisodes !== 'boolean' ||
      !strategies.has(descriptor.strategy) || languages === null ||
      !Number.isInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 1 ||
      descriptor.timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(descriptor.maxCandidates) || descriptor.maxCandidates < 1 ||
      descriptor.maxCandidates > MAX_CANDIDATES ||
      typeof provider.getSources !== 'function') {
    throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_PROVIDER);
  }
  return Object.freeze({
    descriptor: Object.freeze({
      id,
      active: descriptor.active,
      priority: descriptor.priority,
      supportsMovies: descriptor.supportsMovies,
      supportsEpisodes: descriptor.supportsEpisodes,
      languages: Object.freeze([...languages]),
      strategy: descriptor.strategy,
      timeoutMs: descriptor.timeoutMs,
      maxCandidates: descriptor.maxCandidates,
    }),
    getSources: provider.getSources.bind(provider),
  });
};

const byPriorityThenId = (left, right) =>
  right.descriptor.priority - left.descriptor.priority ||
  left.descriptor.id.localeCompare(right.descriptor.id);

const createSourceProviderRegistry = (initialProviders = []) => {
  if (!Array.isArray(initialProviders)) {
    throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_PROVIDER);
  }
  const entries = new Map();
  const register = (provider) => {
    const entry = normalizeSourceProvider(provider);
    if (entries.has(entry.descriptor.id)) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.DUPLICATE_PROVIDER);
    }
    entries.set(entry.descriptor.id, entry);
    return entry;
  };
  initialProviders.forEach(register);

  const list = () => [...entries.values()].sort(byPriorityThenId);
  const listForMedia = (input) => {
    const media = normalizeMediaContext(input);
    if (!media) throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
    return list().filter(({ descriptor }) => descriptor.active &&
      (media.contentType === 'movie'
        ? descriptor.supportsMovies
        : descriptor.supportsEpisodes));
  };

  return Object.freeze({
    register,
    get: (id) => entries.get(id) || null,
    list,
    listForMedia,
  });
};

module.exports = {
  SOURCE_STRATEGIES,
  createSourceProviderRegistry,
  normalizeSourceProvider,
};
