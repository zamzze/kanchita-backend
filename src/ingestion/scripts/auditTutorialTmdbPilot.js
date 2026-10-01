'use strict';

const fs = require('node:fs');
const path = require('node:path');
const tmdb = require('../tmdb/tmdbClient');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SAMPLE_UNIQUE = Math.max(1, Number.parseInt(process.env.TUTORIAL_TMDB_SAMPLE_UNIQUE || '60', 10));
const SAMPLE_UNMATCHED = Math.max(1, Number.parseInt(process.env.TUTORIAL_TMDB_SAMPLE_UNMATCHED || '60', 10));
const DELAY_MS = Math.max(0, Number.parseInt(process.env.TUTORIAL_TMDB_DELAY_MS || '250', 10));

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const releaseYear = (value) => {
  const match = String(value || '').match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
};

const sampleEvenly = (records, count) => {
  if (records.length <= count) return [...records];
  const output = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (records.length - 1)) / (count - 1));
    if (!seen.has(index)) {
      seen.add(index);
      output.push(records[index]);
    }
  }
  return output;
};

const searchMovie = async (query, year) => {
  const params = {
    query,
    include_adult: false,
  };
  if (year) params.primary_release_year = year;

  let response = await tmdb.get('/search/movie', params);
  let fallbackWithoutYear = false;

  if (year && (!Array.isArray(response.results) || response.results.length === 0)) {
    fallbackWithoutYear = true;
    response = await tmdb.get('/search/movie', { query, include_adult: false });
  }

  return {
    results: Array.isArray(response.results) ? response.results : [],
    totalResults: Number(response.total_results || 0),
    totalPages: Number(response.total_pages || 0),
    fallbackWithoutYear,
  };
};

const evaluate = (record, search) => {
  const query = record?.slug?.titleRaw || '';
  const normalizedQuery = normalize(query);
  const slugYear = record?.slug?.year || null;
  const localTmdbId = Number(record?.result?.localMovie?.tmdbId || 0) || null;

  const exact = search.results.filter((item) => {
    const title = normalize(item.title);
    const originalTitle = normalize(item.original_title);
    return normalizedQuery && (normalizedQuery === title || normalizedQuery === originalTitle);
  });

  const exactYear = slugYear
    ? exact.filter((item) => releaseYear(item.release_date) === slugYear)
    : [];

  const localInAll = localTmdbId
    ? search.results.some((item) => Number(item.id) === localTmdbId)
    : false;
  const localInExact = localTmdbId
    ? exact.some((item) => Number(item.id) === localTmdbId)
    : false;

  let status = 'unresolved';
  let selected = null;
  const reasons = [];

  if (slugYear && exactYear.length === 1) {
    status = 'verified_title_year';
    selected = exactYear[0];
    reasons.push('single_exact_title_exact_year');
  } else if (localTmdbId && localInExact && exact.length === 1) {
    status = 'verified_local_tmdb_unique_exact';
    selected = exact[0];
    reasons.push('local_tmdb_is_single_exact_result');
  } else if (localTmdbId && localInExact && exact.length > 1) {
    status = 'local_tmdb_exact_but_ambiguous';
    selected = exact.find((item) => Number(item.id) === localTmdbId) || null;
    reasons.push('local_tmdb_present_among_multiple_exact_results');
  } else if (!localTmdbId && exact.length === 1) {
    status = 'candidate_unique_exact';
    selected = exact[0];
    reasons.push('single_exact_result_without_local_anchor');
  } else if (exact.length > 1) {
    status = 'ambiguous_exact';
    reasons.push('multiple_exact_results');
  } else if (search.results.length > 0) {
    status = 'fuzzy_only';
    reasons.push('results_exist_but_no_exact_title');
  } else {
    status = 'no_results';
    reasons.push('tmdb_search_empty');
  }

  return {
    query,
    slugYear,
    localTmdbId,
    localInAll,
    localInExact,
    exactCount: exact.length,
    exactYearCount: exactYear.length,
    status,
    reasons,
    selected,
  };
};

const inc = (object, key) => {
  object[key] = (object[key] || 0) + 1;
};

const sanitizeSelected = (selected) => selected ? {
  tmdbId: selected.id,
  title: selected.title || null,
  originalTitle: selected.original_title || null,
  releaseDate: selected.release_date || null,
  popularity: selected.popularity ?? null,
  voteCount: selected.vote_count ?? null,
  posterPath: selected.poster_path || null,
} : null;

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-tmdb-pilot -- <tutorial-local-matches-private.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = input.records || [];

  const uniquePool = records
    .filter((record) => record?.result?.status === 'matched_unique_title')
    .sort((a, b) => String(a.tutorialUrl).localeCompare(String(b.tutorialUrl)));

  const unmatchedPool = records
    .filter((record) => record?.result?.status === 'unmatched')
    .sort((a, b) => String(a.tutorialUrl).localeCompare(String(b.tutorialUrl)));

  const sample = [
    ...sampleEvenly(uniquePool, SAMPLE_UNIQUE).map((record) => ({ group: 'local_unique', record })),
    ...sampleEvenly(unmatchedPool, SAMPLE_UNMATCHED).map((record) => ({ group: 'local_unmatched', record })),
  ];

  const decisions = {};
  const byGroup = {
    local_unique: {},
    local_unmatched: {},
  };
  const privateRecords = [];
  let requests = 0;
  let requestErrors = 0;
  let localAnchorsChecked = 0;
  let localAnchorsFoundAny = 0;
  let localAnchorsFoundExact = 0;

  console.log('[TutorialTmdbPilot] Starting');
  console.log(`  local unique pool : ${uniquePool.length}`);
  console.log(`  unmatched pool    : ${unmatchedPool.length}`);
  console.log(`  unique sample     : ${Math.min(SAMPLE_UNIQUE, uniquePool.length)}`);
  console.log(`  unmatched sample  : ${Math.min(SAMPLE_UNMATCHED, unmatchedPool.length)}`);
  console.log(`  total sample      : ${sample.length}`);
  console.log('  only normalized slug title/year are sent to TMDB search');
  console.log('');

  for (let i = 0; i < sample.length; i += 1) {
    const { group, record } = sample[i];
    const query = record?.slug?.titleRaw || '';
    const year = record?.slug?.year || null;

    let search;
    let error = null;
    try {
      search = await searchMovie(query, year);
      requests += search.fallbackWithoutYear ? 2 : 1;
    } catch (err) {
      requestErrors += 1;
      error = err?.message || 'TMDB_ERROR';
      search = { results: [], totalResults: 0, totalPages: 0, fallbackWithoutYear: false };
    }

    const evaluation = error
      ? {
          query,
          slugYear: year,
          localTmdbId: Number(record?.result?.localMovie?.tmdbId || 0) || null,
          localInAll: false,
          localInExact: false,
          exactCount: 0,
          exactYearCount: 0,
          status: 'tmdb_error',
          reasons: ['request_failed'],
          selected: null,
        }
      : evaluate(record, search);

    inc(decisions, evaluation.status);
    inc(byGroup[group], evaluation.status);

    if (evaluation.localTmdbId) {
      localAnchorsChecked += 1;
      if (evaluation.localInAll) localAnchorsFoundAny += 1;
      if (evaluation.localInExact) localAnchorsFoundExact += 1;
    }

    privateRecords.push({
      group,
      tutorialUrl: record.tutorialUrl,
      slug: record.slug,
      localMatch: record.result,
      tmdbSearch: {
        query,
        year,
        resultCountFirstPage: search.results.length,
        totalResults: search.totalResults,
        totalPages: search.totalPages,
        fallbackWithoutYear: search.fallbackWithoutYear,
        exactCount: evaluation.exactCount,
        exactYearCount: evaluation.exactYearCount,
        localInAll: evaluation.localInAll,
        localInExact: evaluation.localInExact,
        status: evaluation.status,
        reasons: evaluation.reasons,
        selected: sanitizeSelected(evaluation.selected),
      },
      error,
    });

    const current = i + 1;
    if (current === 1 || current % 20 === 0 || current === sample.length) {
      console.log(`  ${current}/${sample.length} | ${JSON.stringify(decisions)}`);
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const strongVerified =
    (decisions.verified_title_year || 0) +
    (decisions.verified_local_tmdb_unique_exact || 0);

  const uniqueCandidates = decisions.candidate_unique_exact || 0;
  const reviewNeeded =
    (decisions.local_tmdb_exact_but_ambiguous || 0) +
    (decisions.ambiguous_exact || 0) +
    (decisions.fuzzy_only || 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      privateDetailFileContainsRealValues: true,
      externalApiRequests: true,
      externalService: 'TMDB',
      valuesSentExternally: ['normalized tutorial slug title', 'slug year when available'],
      iframeDestinationsRequested: false,
    },
    population: {
      localUniquePool: uniquePool.length,
      unmatchedPool: unmatchedPool.length,
      uniqueSample: sample.filter((item) => item.group === 'local_unique').length,
      unmatchedSample: sample.filter((item) => item.group === 'local_unmatched').length,
      totalSample: sample.length,
    },
    tmdb: {
      requests,
      requestErrors,
    },
    decisions,
    decisionsByGroup: byGroup,
    localAnchorValidation: {
      checked: localAnchorsChecked,
      foundAnywhereFirstPage: localAnchorsFoundAny,
      foundAmongExactTitleResults: localAnchorsFoundExact,
    },
    interpretation: {
      strongVerified,
      uniqueExactCandidatesWithoutLocalAnchor: uniqueCandidates,
      reviewNeeded,
      noResults: decisions.no_results || 0,
    },
    recommendation: null,
  };

  const usable = strongVerified + uniqueCandidates;
  const usableRate = sample.length ? usable / sample.length : 0;
  if (usableRate >= 0.8) {
    summary.recommendation = 'SLUG_TO_TMDB_MATCHING_HIGHLY_VIABLE';
  } else if (usableRate >= 0.5) {
    summary.recommendation = 'SLUG_TO_TMDB_MATCHING_VIABLE_WITH_REVIEW_QUEUE';
  } else {
    summary.recommendation = 'IMPROVE_SLUG_CLEANING_OR_ADD_MORE_SIGNALS';
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-tmdb-pilot-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-tmdb-pilot-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log('[TutorialTmdbPilot] Complete');
  console.log(`  total sample              : ${sample.length}`);
  console.log(`  TMDB requests             : ${requests}`);
  console.log(`  request errors            : ${requestErrors}`);
  console.log(`  strong verified           : ${strongVerified}`);
  console.log(`  unique exact candidates   : ${uniqueCandidates}`);
  console.log(`  review needed             : ${reviewNeeded}`);
  console.log(`  no results                : ${decisions.no_results || 0}`);
  console.log(`  local anchors checked     : ${localAnchorsChecked}`);
  console.log(`  local anchors exact       : ${localAnchorsFoundExact}`);
  console.log(`  recommendation            : ${summary.recommendation}`);
  console.log(`  private details           : ${privateFile}`);
  console.log(`  safe summary              : ${summaryFile}`);
};

main().catch((error) => {
  console.error(`[TutorialTmdbPilot] ${error.message}`);
  process.exitCode = 1;
});
