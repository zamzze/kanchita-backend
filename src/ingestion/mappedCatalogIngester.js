'use strict';

const { normalizeCatalogItem } = require('./catalogSeeder');

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const invalid = (code) => Object.assign(new Error(code), { code });
const transient = (error) => error?.code === 'TMDB_TIMEOUT' ||
  error?.code === 'TMDB_REQUEST_FAILED' || error?.status === 429 ||
  Number.isInteger(error?.status) && error.status >= 500;

const parseMappedCatalogArgs = (args) => {
  if (!Array.isArray(args)) throw invalid('MAPPED_CATALOG_INVALID_ARGS');
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--provider', '--limit'].includes(name) ||
        Object.hasOwn(values, name) || typeof value !== 'string' ||
        value.startsWith('--')) throw invalid('MAPPED_CATALOG_INVALID_ARGS');
    values[name] = value;
  }
  const providerId = values['--provider'];
  const rawLimit = values['--limit'];
  const limit = rawLimit === undefined ? null : /^[1-9]\d*$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!PROVIDER_ID.test(providerId || '') ||
      (limit !== null && (!Number.isSafeInteger(limit) || limit > 10_000))) {
    throw invalid('MAPPED_CATALOG_INVALID_ARGS');
  }
  return Object.freeze({ providerId, limit });
};

const createMappedCatalogIngester = ({ store, fetchMovie, fetchSeries,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pauseMs = 250 } = {}) => {
  if (!store || typeof store.listMappedIdentities !== 'function' ||
      typeof store.upsertItem !== 'function' || typeof fetchMovie !== 'function' ||
      typeof fetchSeries !== 'function' || typeof sleep !== 'function' ||
      !Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 5_000) {
    throw invalid('MAPPED_CATALOG_INVALID_CONFIG');
  }

  const fetchWithRetry = async (type, tmdbId) => {
    const fetchDetail = type === 'movie' ? fetchMovie : fetchSeries;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await fetchDetail(tmdbId); }
      catch (error) {
        if (!transient(error) || attempt === 2) throw error;
        const delay = Math.max(500 * 2 ** attempt,
          Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
        await sleep(Math.min(delay, 5_000));
      }
    }
    throw invalid('MAPPED_CATALOG_FETCH_FAILED');
  };

  const run = async ({ providerId, limit = null } = {}) => {
    if (!PROVIDER_ID.test(providerId || '') ||
        (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000))) {
      throw invalid('MAPPED_CATALOG_INVALID_ARGS');
    }
    const rows = await store.listMappedIdentities(providerId);
    if (!Array.isArray(rows)) throw invalid('MAPPED_CATALOG_INVALID_MAPPINGS');
    const identities = [];
    const seen = new Set();
    for (const row of rows) {
      if (!['movie', 'series'].includes(row?.catalog_type) ||
          !Number.isSafeInteger(row.tmdb_id) || row.tmdb_id < 1 ||
          typeof row.already_present !== 'boolean') {
        throw invalid('MAPPED_CATALOG_INVALID_MAPPINGS');
      }
      const key = `${row.catalog_type}:${row.tmdb_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identities.push(row);
    }
    const selected = limit === null ? identities : identities.slice(0, limit);
    const stats = { requested: selected.length, alreadyPresent: 0,
      inserted: 0, updated: 0, notFound: 0, failed: 0 };
    let attempted = 0;
    for (const row of selected) {
      if (row.already_present) { stats.alreadyPresent += 1; continue; }
      if (attempted > 0 && pauseMs) await sleep(pauseMs);
      attempted += 1;
      try {
        const detail = await fetchWithRetry(row.catalog_type, row.tmdb_id);
        if (!detail || detail.id !== row.tmdb_id) {
          stats.failed += 1;
          continue;
        }
        const item = normalizeCatalogItem(row.catalog_type, detail);
        if (!item) { stats.failed += 1; continue; }
        const change = await store.upsertItem(row.catalog_type, item);
        if (change === 'inserted' || change === 'updated') stats[change] += 1;
        else if (change === 'unchanged') stats.alreadyPresent += 1;
        else stats.failed += 1;
      } catch (error) {
        if (error?.status === 404) stats.notFound += 1;
        else stats.failed += 1;
      }
    }
    return Object.freeze(stats);
  };
  return Object.freeze({ run });
};

module.exports = { createMappedCatalogIngester, parseMappedCatalogArgs };
