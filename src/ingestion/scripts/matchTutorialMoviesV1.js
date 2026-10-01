'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const pool = require('../../config/db');
const tmdb = require('../tmdb/tmdbClient');

const argv = process.argv.slice(2);
const inputArg = argv.find((arg) => !arg.startsWith('--'));
const RESET = argv.includes('--reset');

const CONCURRENCY = Math.max(
  1,
  Math.min(12, Number.parseInt(process.env.TUTORIAL_MATCH_CONCURRENCY || '4', 10))
);
const DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.TUTORIAL_MATCH_DELAY_MS || '150', 10)
);
const RETRIES = Math.max(
  0,
  Number.parseInt(process.env.TUTORIAL_MATCH_RETRIES || '2', 10)
);
const LIMIT = Math.max(
  0,
  Number.parseInt(process.env.TUTORIAL_MATCH_LIMIT || '0', 10)
);

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const NDJSON_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-matcher-v1.ndjson');
const LATEST_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-matcher-v1-latest.json');
const CACHE_FILE = path.join(PRIVATE_DIR, 'tutorial-tmdb-search-cache-v1.json');
const SUMMARY_FILE = path.join(REPORT_DIR, 'tutorial-movie-matcher-v1-summary.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const parseSlug = (tutorialUrl) => {
  try {
    const url = new URL(tutorialUrl);
    const rawSlug = decodeURIComponent(
      url.pathname.split('/').filter(Boolean).pop() || ''
    );

    const years = [...rawSlug.matchAll(/(?:^|[-_\s(])(19\d{2}|20\d{2})(?=$|[-_\s)])/g)]
      .map((match) => Number(match[1]));
    const year = years.length ? years[years.length - 1] : null;

    const titleRaw = rawSlug
      .replace(/[-_]+/g, ' ')
      .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      rawSlug,
      titleRaw,
      normalizedTitle: normalize(titleRaw),
      year,
    };
  } catch {
    return {
      rawSlug: null,
      titleRaw: null,
      normalizedTitle: '',
      year: null,
    };
  }
};

const releaseYear = (value) => {
  const match = String(value || '').match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
};

const createLocalIndex = (movies) => {
  const index = new Map();

  const add = (key, movie, source) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Map());
    const bucket = index.get(key);
    const existing = bucket.get(movie.id);

    if (!existing) {
      bucket.set(movie.id, { movie, sources: [source] });
    } else if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
  };

  for (const movie of movies) {
    add(normalize(movie.title), movie, 'title');
    add(normalize(movie.original_title), movie, 'original_title');
  }

  return index;
};

const cacheKeyFor = (title, year) =>
  JSON.stringify([normalize(title), year || null]);

const loadJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
};

const loadCompleted = async () => {
  const completed = new Map();
  if (!fs.existsSync(NDJSON_FILE)) return completed;

  const stream = fs.createReadStream(NDJSON_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.tutorialUrl && record?.match?.method !== 'tmdb_error') {
        completed.set(record.tutorialUrl, record);
      }
    } catch {
      // Ignore an interrupted final line and keep the completed checkpoints.
    }
  }

  return completed;
};

const compactTmdbItem = (item) => ({
  id: Number(item.id),
  title: item.title || null,
  originalTitle: item.original_title || null,
  releaseDate: item.release_date || null,
  popularity: item.popularity ?? null,
  voteCount: item.vote_count ?? null,
  posterPath: item.poster_path || null,
});

const searchTmdbOnce = async (title, year) => {
  const params = {
    query: title,
    include_adult: false,
  };

  if (year) params.primary_release_year = year;

  let response = await tmdb.get('/search/movie', params);
  let results = Array.isArray(response.results) ? response.results : [];
  let fallbackWithoutYear = false;

  if (year && results.length === 0) {
    fallbackWithoutYear = true;
    response = await tmdb.get('/search/movie', {
      query: title,
      include_adult: false,
    });
    results = Array.isArray(response.results) ? response.results : [];
  }

  return {
    results: results.slice(0, 20).map(compactTmdbItem),
    fallbackWithoutYear,
  };
};

const withRetry = async (fn) => {
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await sleep(500 * (attempt + 1));
    }
  }

  throw lastError;
};

const exactTmdbMatches = (slug, results) =>
  results.filter((item) => {
    const title = normalize(item.title);
    const original = normalize(item.originalTitle);
    return slug.normalizedTitle &&
      (slug.normalizedTitle === title || slug.normalizedTitle === original);
  });

const classify = ({ slug, localHits, results }) => {
  const exact = exactTmdbMatches(slug, results);
  const exactYear = slug.year
    ? exact.filter((item) => releaseYear(item.releaseDate) === slug.year)
    : [];

  const localTmdbIds = new Set(
    localHits
      .map((hit) => Number(hit.movie.tmdb_id || 0))
      .filter(Boolean)
  );

  const localExactTmdb = exact.filter((item) => localTmdbIds.has(Number(item.id)));

  if (slug.year && exactYear.length === 1) {
    return {
      status: 'AUTO_MATCH',
      method: 'tmdb_title_year',
      score: 100,
      selected: exactYear[0],
      reasons: ['single_exact_title_exact_year'],
      exactCount: exact.length,
      exactYearCount: exactYear.length,
    };
  }

  if (
    localHits.length === 1 &&
    localTmdbIds.size === 1 &&
    localExactTmdb.length === 1 &&
    exact.length === 1
  ) {
    return {
      status: 'AUTO_MATCH',
      method: 'local_tmdb_exact',
      score: 98,
      selected: localExactTmdb[0],
      reasons: ['single_local_anchor_is_single_exact_tmdb_result'],
      exactCount: exact.length,
      exactYearCount: exactYear.length,
    };
  }

  if (localExactTmdb.length > 0 && exact.length > 1) {
    return {
      status: 'REVIEW',
      method: 'local_anchor_ambiguous',
      score: 85,
      selected: localExactTmdb.length === 1 ? localExactTmdb[0] : null,
      reasons: ['local_anchor_present_among_multiple_exact_results'],
      exactCount: exact.length,
      exactYearCount: exactYear.length,
    };
  }

  if (exact.length === 1) {
    return {
      status: 'AUTO_MATCH',
      method: 'tmdb_exact_unique',
      score: 95,
      selected: exact[0],
      reasons: ['single_exact_tmdb_result'],
      exactCount: exact.length,
      exactYearCount: exactYear.length,
    };
  }

  if (exact.length > 1) {
    return {
      status: 'REVIEW',
      method: 'ambiguous_exact',
      score: 75,
      selected: null,
      reasons: ['multiple_exact_tmdb_results'],
      exactCount: exact.length,
      exactYearCount: exactYear.length,
    };
  }

  if (results.length > 0) {
    return {
      status: 'REVIEW',
      method: 'fuzzy_candidates',
      score: 50,
      selected: null,
      reasons: ['tmdb_results_without_exact_title'],
      exactCount: 0,
      exactYearCount: 0,
    };
  }

  return {
    status: 'UNMATCHED',
    method: 'no_results',
    score: 0,
    selected: null,
    reasons: ['tmdb_search_empty'],
    exactCount: 0,
    exactYearCount: 0,
  };
};

const summarize = (records, stats) => {
  const byStatus = {};
  const byMethod = {};
  let withYear = 0;
  let localCandidate = 0;
  let autoMappedToExistingLocalMovie = 0;

  for (const record of records) {
    byStatus[record.match.status] = (byStatus[record.match.status] || 0) + 1;
    byMethod[record.match.method] = (byMethod[record.match.method] || 0) + 1;
    if (record.slug.year) withYear += 1;
    if (record.local.candidateCount > 0) localCandidate += 1;
    if (record.match.localMovieId) autoMappedToExistingLocalMovie += 1;
  }

  const total = records.length;
  const auto = byStatus.AUTO_MATCH || 0;

  return {
    generatedAt: new Date().toISOString(),
    mode: 'DRY_RUN_READ_ONLY',
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      privateOutputsContainRealValues: true,
      externalApiRequests: true,
      externalService: 'TMDB',
      valuesSentExternally: ['normalized tutorial slug title', 'slug year when available'],
      iframeDestinationsRequested: false,
      databaseWrites: false,
    },
    population: {
      totalProcessed: total,
      tutorialsWithYearInSlug: withYear,
      tutorialsWithLocalCandidate: localCandidate,
    },
    decisions: {
      byStatus,
      byMethod,
      autoMatchRate: total ? Number((auto / total).toFixed(4)) : 0,
      autoMappedToExistingLocalMovie,
    },
    execution: stats,
    outputs: {
      ndjson: path.relative(process.cwd(), NDJSON_FILE),
      latestPrivate: path.relative(process.cwd(), LATEST_FILE),
      tmdbCachePrivate: path.relative(process.cwd(), CACHE_FILE),
    },
  };
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run match:tutorial-movies:v1 -- ' +
      '<tutorial-server-extraction-latest.json> [--reset]'
    );
  }

  if (!process.env.TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY is required in .env');
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error('Input file not found: ' + inputFile);
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  if (RESET) {
    for (const file of [NDJSON_FILE, LATEST_FILE, CACHE_FILE, SUMMARY_FILE]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }

  const extraction = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  let tutorials = (extraction.records || [])
    .filter((record) => record.status === 'ok' && record.tutorialUrl)
    .sort((a, b) => String(a.tutorialUrl).localeCompare(String(b.tutorialUrl)));

  if (LIMIT > 0) tutorials = tutorials.slice(0, LIMIT);

  const movieSql =
    'SELECT id, tmdb_id, title, original_title, release_year, is_published ' +
    'FROM movies';
  const { rows: movies } = await pool.query(movieSql);
  const localIndex = createLocalIndex(movies);

  const completed = RESET ? new Map() : await loadCompleted();
  const cache = RESET ? {} : loadJson(CACHE_FILE, {});

  const pending = tutorials.filter((record) => !completed.has(record.tutorialUrl));

  const stats = {
    tutorialsInput: tutorials.length,
    localMovies: movies.length,
    alreadyCompleted: tutorials.length - pending.length,
    pendingAtStart: pending.length,
    processedThisRun: 0,
    tmdbNetworkQueries: 0,
    tmdbCacheHits: 0,
    requestErrors: 0,
    concurrency: CONCURRENCY,
    delayMs: DELAY_MS,
    retries: RETRIES,
    limit: LIMIT || null,
  };

  console.log('[TutorialMovieMatcherV1] Starting');
  console.log('  mode              : DRY_RUN_READ_ONLY');
  console.log('  tutorials         : ' + tutorials.length);
  console.log('  local movies      : ' + movies.length);
  console.log('  resumed           : ' + stats.alreadyCompleted);
  console.log('  pending           : ' + pending.length);
  console.log('  concurrency       : ' + CONCURRENCY);
  console.log('  no database writes will be performed');
  console.log('');

  const appendRecord = (record) => {
    fs.appendFileSync(NDJSON_FILE, JSON.stringify(record) + '\n', 'utf8');
    completed.set(record.tutorialUrl, record);
    stats.processedThisRun += 1;

    if (stats.processedThisRun % 100 === 0) {
      writeJsonAtomic(CACHE_FILE, cache);
    }
  };

  const processTutorial = async (tutorial) => {
    const slug = parseSlug(tutorial.tutorialUrl);
    const localBucket = localIndex.get(slug.normalizedTitle);
    const localHits = localBucket ? [...localBucket.values()] : [];

    if (!slug.normalizedTitle) {
      return {
        tutorialUrl: tutorial.tutorialUrl,
        slug,
        local: { candidateCount: localHits.length, candidates: [] },
        tmdb: { cacheHit: false, resultCount: 0, candidates: [] },
        match: {
          status: 'UNMATCHED',
          method: 'invalid_slug',
          score: 0,
          selectedTmdbId: null,
          localMovieId: null,
          reasons: ['slug_title_empty'],
        },
      };
    }

    const cacheKey = cacheKeyFor(slug.titleRaw, slug.year);
    let search = cache[cacheKey];
    const cacheHit = Boolean(search);

    if (search) {
      stats.tmdbCacheHits += 1;
    } else {
      try {
        search = await withRetry(() => searchTmdbOnce(slug.titleRaw, slug.year));
        cache[cacheKey] = search;
        stats.tmdbNetworkQueries += search.fallbackWithoutYear ? 2 : 1;
      } catch (error) {
        stats.requestErrors += 1;
        return {
          tutorialUrl: tutorial.tutorialUrl,
          slug,
          local: {
            candidateCount: localHits.length,
            candidates: localHits.map((hit) => ({
              id: hit.movie.id,
              tmdbId: hit.movie.tmdb_id,
              releaseYear: hit.movie.release_year,
              sources: hit.sources,
            })),
          },
          tmdb: {
            cacheHit: false,
            error: error?.message || 'TMDB_ERROR',
            resultCount: 0,
            candidates: [],
          },
          match: {
            status: 'REVIEW',
            method: 'tmdb_error',
            score: 0,
            selectedTmdbId: null,
            localMovieId: null,
            reasons: ['tmdb_request_failed'],
          },
        };
      }
    }

    const decision = classify({
      slug,
      localHits,
      results: search.results || [],
    });

    const selectedTmdbId = decision.selected ? Number(decision.selected.id) : null;
    const localMovie = selectedTmdbId
      ? localHits.find((hit) => Number(hit.movie.tmdb_id) === selectedTmdbId)?.movie || null
      : null;

    return {
      tutorialUrl: tutorial.tutorialUrl,
      slug,
      local: {
        candidateCount: localHits.length,
        candidates: localHits.map((hit) => ({
          id: hit.movie.id,
          tmdbId: hit.movie.tmdb_id,
          releaseYear: hit.movie.release_year,
          sources: hit.sources,
        })),
      },
      tmdb: {
        cacheHit,
        fallbackWithoutYear: Boolean(search.fallbackWithoutYear),
        resultCount: (search.results || []).length,
        candidates: (search.results || []).slice(0, 5),
      },
      match: {
        status: decision.status,
        method: decision.method,
        score: decision.score,
        selectedTmdbId,
        localMovieId: localMovie?.id || null,
        exactCount: decision.exactCount,
        exactYearCount: decision.exactYearCount,
        reasons: decision.reasons,
      },
    };
  };

  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;

      const tutorial = pending[index];
      const record = await processTutorial(tutorial);
      appendRecord(record);

      const done = stats.alreadyCompleted + stats.processedThisRun;
      if (
        stats.processedThisRun === 1 ||
        stats.processedThisRun % 250 === 0 ||
        done === tutorials.length
      ) {
        console.log(
          '  ' + done + '/' + tutorials.length +
          ' | network=' + stats.tmdbNetworkQueries +
          ' cache=' + stats.tmdbCacheHits +
          ' errors=' + stats.requestErrors
        );
      }

      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, pending.length)) },
      () => worker()
    )
  );

  writeJsonAtomic(CACHE_FILE, cache);

  const finalMap = await loadCompleted();
  const records = tutorials
    .map((tutorial) => finalMap.get(tutorial.tutorialUrl))
    .filter(Boolean);

  writeJsonAtomic(LATEST_FILE, {
    generatedAt: new Date().toISOString(),
    records,
  });

  const summary = summarize(records, stats);
  writeJsonAtomic(SUMMARY_FILE, summary);

  console.log('');
  console.log('[TutorialMovieMatcherV1] Complete');
  console.log('  processed total  : ' + records.length);
  console.log('  AUTO_MATCH       : ' + (summary.decisions.byStatus.AUTO_MATCH || 0));
  console.log('  REVIEW           : ' + (summary.decisions.byStatus.REVIEW || 0));
  console.log('  UNMATCHED        : ' + (summary.decisions.byStatus.UNMATCHED || 0));
  console.log('  auto match rate  : ' + summary.decisions.autoMatchRate);
  console.log('  network queries  : ' + stats.tmdbNetworkQueries);
  console.log('  cache hits       : ' + stats.tmdbCacheHits);
  console.log('  request errors   : ' + stats.requestErrors);
  console.log('  private latest   : ' + LATEST_FILE);
  console.log('  safe summary     : ' + SUMMARY_FILE);
};

main()
  .catch((error) => {
    console.error('[TutorialMovieMatcherV1] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
