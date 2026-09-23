'use strict';

const { normalizeMovie, normalizeSeries } = require('./normalizer/movieNormalizer');
const { uuid } = require('../db/bulkPersistence.validation');

const TYPES = Object.freeze(['movie', 'series']);
const MIN_YEAR = 1900;
const invalid = (code) => Object.assign(new Error(code), { code });
const parsePositive = (value, maximum) => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
};

const parseCatalogArgs = (args, now = new Date()) => {
  if (!Array.isArray(args)) throw invalid('CATALOG_CLI_INVALID_ARGS');
  const names = new Set(['target', 'movies', 'series', 'batch-size', 'resume',
    'movie-ratio', 'max-pages']);
  const values = {};
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === '--dry-run' && !dryRun) { dryRun = true; continue; }
    const name = typeof raw === 'string' && raw.startsWith('--') ? raw.slice(2) : '';
    if (!names.has(name) || Object.hasOwn(values, name) ||
        index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw invalid('CATALOG_CLI_INVALID_ARGS');
    }
    values[name] = args[++index];
  }
  if (values.resume) {
    if (!uuid(values.resume) || dryRun || Object.keys(values).length !== 1) {
      throw invalid('CATALOG_CLI_INVALID_ARGS');
    }
    return Object.freeze({ resume: values.resume, dryRun: false });
  }
  if (values.target && (values.movies || values.series) ||
      values['movie-ratio'] && !values.target) throw invalid('CATALOG_CLI_INVALID_ARGS');
  const target = values.target === undefined ? 20_000 : parsePositive(values.target, 100_000);
  const ratio = values['movie-ratio'] === undefined ? 0.6 : Number(values['movie-ratio']);
  const batchSize = values['batch-size'] === undefined ? 20 :
    parsePositive(values['batch-size'], 100);
  const maxPages = values['max-pages'] === undefined ? 500 :
    parsePositive(values['max-pages'], 500);
  if (!target || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1 ||
      !batchSize || !maxPages) throw invalid('CATALOG_CLI_INVALID_ARGS');
  const explicit = values.movies !== undefined || values.series !== undefined;
  const movie = explicit ? values.movies === undefined ? 0 : parsePositive(values.movies, 100_000)
    : Math.round(target * ratio);
  const series = explicit ? values.series === undefined ? 0 : parsePositive(values.series, 100_000)
    : target - movie;
  if (movie === null || series === null || movie + series < 1 || movie + series > 100_000) {
    throw invalid('CATALOG_CLI_INVALID_ARGS');
  }
  const startYear = now.getUTCFullYear();
  return Object.freeze({ dryRun, config: Object.freeze({
    targets: Object.freeze({ movie, series }), batchSize, maxPages,
    startYear, minYear: MIN_YEAR,
  }) });
};

const normalizeCatalogItem = (type, raw) => {
  if (!TYPES.includes(type) || !raw || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
  const normalized = type === 'movie' ? normalizeMovie(raw) : normalizeSeries(raw);
  const title = typeof normalized.title === 'string' ? normalized.title.trim() : '';
  const original = type === 'series' ? raw.original_name : normalized.original_title;
  const originalTitle = typeof original === 'string' && original.trim()
    ? original.trim() : title;
  const year = normalized.release_year;
  if (!title || title.length > 255 || originalTitle.length > 255 ||
      (year !== null && (!Number.isInteger(year) || year < MIN_YEAR || year > 2100)) ||
      (normalized.description !== null &&
        (typeof normalized.description !== 'string' || normalized.description.length > 8_000)) ||
      [normalized.poster_url, normalized.backdrop_url].some((url) =>
        url !== null && (typeof url !== 'string' || url.length > 500))) return null;
  return Object.freeze({ tmdb_id: raw.id, title, original_title: originalTitle,
    description: normalized.description, release_year: year,
    poster_url: normalized.poster_url, backdrop_url: normalized.backdrop_url,
    rating: normalized.rating });
};

const nextCursor = (cursor, response, count, maxPages, minYear) => {
  const consumed = cursor.offset + count;
  if (consumed < response.results.length) return { ...cursor, offset: consumed };
  const totalPages = Number.isInteger(response.total_pages) && response.total_pages >= 0
    ? Math.min(response.total_pages, maxPages) : 1;
  if (response.results.length && cursor.page < totalPages) {
    return { year: cursor.year, page: cursor.page + 1, offset: 0, done: false };
  }
  const year = cursor.year - 1;
  return { year, page: 1, offset: 0, done: year < minYear };
};

const isTransient = (error) => error?.code === 'TMDB_TIMEOUT' ||
  error?.code === 'TMDB_REQUEST_FAILED' ||
  error?.status === 429 || Number.isInteger(error?.status) && error.status >= 500;

const createCatalogSeeder = ({ fetchPage, store = null, sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms)), logger = () => {},
requestPauseMs = 250 } = {}) => {
  if (typeof fetchPage !== 'function' || typeof sleep !== 'function' ||
      typeof logger !== 'function' || !Number.isInteger(requestPauseMs) ||
      requestPauseMs < 0 || requestPauseMs > 5_000) throw invalid('CATALOG_SEED_INVALID_CONFIG');

  const fetchBounded = async (type, cursor) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchPage(type, cursor.year, cursor.page);
        if (!response || !Array.isArray(response.results) || response.results.length > 20 ||
            !Number.isInteger(response.total_pages) || response.total_pages < 0) {
          throw invalid('CATALOG_PAGE_INVALID');
        }
        return response;
      } catch (error) {
        if (!isTransient(error) || attempt === 2) throw error;
        const backoff = Math.max(500 * 2 ** attempt,
          Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
        await sleep(Math.min(backoff, 5_000));
      }
    }
    throw invalid('CATALOG_FETCH_FAILED');
  };

  const run = async (options) => {
    if (!options || typeof options !== 'object') throw invalid('CATALOG_SEED_INVALID_CONFIG');
    if (!options.dryRun && (!store || typeof store.createRun !== 'function' ||
        typeof store.resumeRun !== 'function' || typeof store.commitBatch !== 'function')) {
      throw invalid('CATALOG_SEED_INVALID_STORE');
    }
    let current;
    let config;
    const dryRun = options.dryRun === true;
    const seen = { movie: new Set(), series: new Set() };
    if (dryRun) {
      config = options.config;
      current = { id: null, checkpoint_json: { cursor: Object.fromEntries(TYPES.map((type) =>
        [type, { year: config.startYear, page: 1, offset: 0,
          done: config.targets[type] === 0 }])), progress: { movie: 0, series: 0 },
      stats: { inserted: 0, updated: 0, unchanged: 0, failed: 0 },
      pages: { movie: 0, series: 0 } } };
    } else {
      const loaded = options.resume ? await store.getRun(options.resume)
        : await store.createRun(options.config);
      if (!loaded) throw invalid('CATALOG_SEED_RUN_NOT_FOUND');
      current = await store.resumeRun(loaded.id);
      if (!current) throw invalid('CATALOG_SEED_NOT_RESUMABLE');
      config = current.config_json;
    }
    try {
      for (const type of TYPES) {
        while (!current.checkpoint_json.cursor[type].done) {
          const checkpoint = current.checkpoint_json;
          const cursor = checkpoint.cursor[type];
          if (checkpoint.progress[type] >= config.targets[type]) {
            const done = { ...cursor, done: true };
            if (dryRun) checkpoint.cursor[type] = done;
            else current = (await store.commitBatch({ runId: current.id, type,
              expectedCursor: cursor, nextCursor: done, items: [] })).run;
            continue;
          }
          const response = await fetchBounded(type, cursor);
          const remaining = config.targets[type] - checkpoint.progress[type];
          const batch = response.results.slice(cursor.offset,
            cursor.offset + Math.min(config.batchSize, remaining));
          const ids = new Set();
          const items = [];
          let failed = 0;
          for (const raw of batch) {
            const item = normalizeCatalogItem(type, raw);
            if (!item) { failed += 1; continue; }
            if (ids.has(item.tmdb_id)) continue;
            ids.add(item.tmdb_id);
            items.push(item);
          }
          const next = nextCursor(cursor, response, batch.length, config.maxPages,
            config.minYear);
          const pageFinished = next.page !== cursor.page || next.year !== cursor.year;
          if (dryRun) {
            for (const item of items) seen[type].add(item.tmdb_id);
            checkpoint.progress[type] = Math.min(seen[type].size, config.targets[type]);
            if (checkpoint.progress[type] >= config.targets[type]) next.done = true;
            checkpoint.cursor[type] = next;
            checkpoint.stats.failed += failed;
            if (pageFinished) checkpoint.pages[type] += 1;
          } else {
            current = (await store.commitBatch({ runId: current.id, type,
              expectedCursor: cursor, nextCursor: next, items, failed, pageFinished })).run;
          }
          logger({ runId: current.id, type, progress: current.checkpoint_json.progress,
            targets: config.targets, stats: current.checkpoint_json.stats,
            cursor: current.checkpoint_json.cursor[type], dryRun });
          if (!current.checkpoint_json.cursor[type].done && requestPauseMs) {
            await sleep(requestPauseMs);
          }
        }
      }
      if (!dryRun) current = await store.completeRun(current.id) || current;
      return Object.freeze({ runId: current.id, dryRun, checkpoint: current.checkpoint_json,
        status: dryRun ? 'dry_run' : current.status });
    } catch (error) {
      if (!dryRun && current?.id && error?.code !== 'CATALOG_SEED_CHECKPOINT_CONFLICT') {
        await store.markFailed(current.id, 'CATALOG_SEED_FAILED');
      }
      throw error;
    }
  };
  return Object.freeze({ run });
};

module.exports = { createCatalogSeeder, nextCursor, normalizeCatalogItem, parseCatalogArgs };
