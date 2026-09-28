'use strict';

const { ID, REGION } = require('./mappingContract');

const invalid = (code) => Object.assign(new Error(code), { code });

const normalizeProvider = (input) => {
  if (!input || !ID.test(input.id || '') || typeof input.enabled !== 'boolean' ||
      !Number.isInteger(input.priority) || Math.abs(input.priority) > 1_000 ||
      typeof input.supportsMovies !== 'boolean' ||
      typeof input.supportsSeries !== 'boolean' ||
      !REGION.test(input.region || '') ||
      !Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1 ||
      input.maxConcurrent > 8 || !Number.isInteger(input.minDelayMs) ||
      input.minDelayMs < 0 || input.minDelayMs > 60_000 ||
      typeof input.discoverMapping !== 'function' ||
      (input.discoverSeriesEpisodes !== undefined &&
        typeof input.discoverSeriesEpisodes !== 'function')) {
    throw invalid('MAPPING_PROVIDER_INVALID');
  }
  return Object.freeze({ id: input.id, enabled: input.enabled,
    priority: input.priority, supportsMovies: input.supportsMovies,
    supportsSeries: input.supportsSeries, region: input.region,
    maxConcurrent: input.maxConcurrent, minDelayMs: input.minDelayMs,
    discoverMapping: input.discoverMapping,
    discoverSeriesEpisodes: input.discoverSeriesEpisodes || null });
};

const createMappingRegistry = (providers = [], {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) => {
  if (!Array.isArray(providers) || typeof sleep !== 'function' ||
      typeof now !== 'function') throw invalid('MAPPING_REGISTRY_INVALID');
  const entries = new Map();
  const states = new Map();
  const register = (input) => {
    const provider = normalizeProvider(input);
    if (entries.has(provider.id)) throw invalid('MAPPING_PROVIDER_DUPLICATE');
    entries.set(provider.id, provider);
    states.set(provider.id, { active: 0, nextAt: 0, waiters: [] });
    return provider;
  };
  for (const provider of providers) register(provider);
  const list = () => Object.freeze([...entries.values()].sort((a, b) =>
    b.priority - a.priority || a.id.localeCompare(b.id)));
  const get = (id) => entries.get(id) || null;
  const select = (ids = null) => {
    if (ids !== null && (!Array.isArray(ids) ||
        ids.some((id) => !ID.test(id || '') || !entries.has(id)))) {
      throw invalid('MAPPING_PROVIDER_UNKNOWN');
    }
    const wanted = ids === null ? null : new Set(ids);
    return Object.freeze(list().filter((provider) => provider.enabled &&
      (wanted === null || wanted.has(provider.id))));
  };
  const executeMethod = async (provider, media, method) => {
    if (get(provider?.id) !== provider || !provider.enabled ||
        typeof provider[method] !== 'function') {
      throw invalid('MAPPING_PROVIDER_UNKNOWN');
    }
    const state = states.get(provider.id);
    while (state.active >= provider.maxConcurrent) {
      await new Promise((resolve) => state.waiters.push(resolve));
    }
    state.active += 1;
    const startAt = Math.max(now(), state.nextAt);
    const waitMs = Math.max(0, startAt - now());
    state.nextAt = startAt + provider.minDelayMs;
    try {
      if (waitMs) await sleep(waitMs);
      return await provider[method](media);
    } finally {
      state.active -= 1;
      state.waiters.shift()?.();
    }
  };
  const execute = (provider, media) => executeMethod(provider, media, 'discoverMapping');
  const executeSeriesEpisodes = (provider, media) =>
    executeMethod(provider, media, 'discoverSeriesEpisodes');
  return Object.freeze({ register, list, get, select, execute,
    executeSeriesEpisodes });
};

module.exports = { createMappingRegistry, normalizeProvider };
