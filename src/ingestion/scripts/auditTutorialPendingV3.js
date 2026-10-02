'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const SUMMARY_FILE = path.join(REPORT_DIR, 'tutorial-pending-v3-summary.json');

const normalize = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const releaseYear = (value) => {
  const match = String(value || '').match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
};

const tokens = (value) => new Set(normalize(value).split(' ').filter(Boolean));

const jaccard = (left, right) => {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
};

const bigrams = (value) => {
  const text = normalize(value).replace(/\s+/g, ' ');
  if (text.length < 2) return text ? [text] : [];
  const output = [];
  for (let i = 0; i < text.length - 1; i += 1) output.push(text.slice(i, i + 2));
  return output;
};

const dice = (left, right) => {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const gram of a) counts.set(gram, (counts.get(gram) || 0) + 1);
  let matches = 0;
  for (const gram of b) {
    const count = counts.get(gram) || 0;
    if (!count) continue;
    matches += 1;
    counts.set(gram, count - 1);
  }
  return (2 * matches) / (a.length + b.length);
};

const similarity = (left, right) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Number((0.55 * dice(a, b) + 0.45 * jaccard(a, b)).toFixed(4));
};

const inc = (object, key) => {
  const safeKey = key || 'unknown';
  object[safeKey] = (object[safeKey] || 0) + 1;
};

const candidateMetrics = (record) => {
  const slugTitle = record?.slug?.normalizedTitle || normalize(record?.slug?.titleRaw);
  const slugYear = Number(record?.slug?.year) || null;
  const candidates = Array.isArray(record?.tmdb?.candidates) ? record.tmdb.candidates : [];

  const ranked = candidates
    .filter((candidate) => Number.isFinite(Number(candidate?.id)))
    .map((candidate) => {
      const titleSim = Math.max(
        similarity(slugTitle, candidate?.title),
        similarity(slugTitle, candidate?.originalTitle)
      );
      const candidateYear = releaseYear(candidate?.releaseDate);
      const yearDelta = slugYear && candidateYear ? Math.abs(slugYear - candidateYear) : null;
      const exactTitle = Boolean(slugTitle) && (
        slugTitle === normalize(candidate?.title) ||
        slugTitle === normalize(candidate?.originalTitle)
      );
      return {
        id: Number(candidate.id),
        titleSim,
        candidateYear,
        yearDelta,
        exactTitle,
      };
    })
    .sort((a, b) => b.titleSim - a.titleSim || a.id - b.id);

  const first = ranked[0] || null;
  const second = ranked[1] || null;
  const margin = first ? Number((first.titleSim - (second?.titleSim || 0)).toFixed(4)) : null;
  const exactCandidates = ranked.filter((item) => item.exactTitle);
  const exactYearCandidates = slugYear
    ? exactCandidates.filter((item) => item.candidateYear === slugYear)
    : [];

  return {
    slugYear,
    ranked,
    first,
    second,
    margin,
    exactCount: exactCandidates.length,
    exactYearCount: exactYearCandidates.length,
  };
};

const main = () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-pending:v3 -- ' +
      '<tutorial-movie-matcher-v2-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) throw new Error('Input file not found: ' + inputFile);

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = Array.isArray(input.records) ? input.records : [];
  const pending = records.filter((record) => record?.match?.status !== 'AUTO_MATCH');

  const byV1Status = {};
  const byV1Method = {};
  const byV2Method = {};
  const noiseTokens = {
    pelicula: 0,
    online: 0,
    latino: 0,
    espanol: 0,
    castellano: 0,
    subtitulado: 0,
    hd: 0,
    full: 0,
    ver: 0,
    gratis: 0,
  };

  const counts = {
    inputRecords: records.length,
    pendingRecords: pending.length,
    review: 0,
    unmatched: 0,
    withSlugYear: 0,
    withoutSlugYear: 0,
    withTmdbCandidates: 0,
    withoutTmdbCandidates: 0,
    withLocalCandidates: 0,
    withUniqueLocalCandidate: 0,
    withMultipleLocalCandidates: 0,
  };

  const localOnly = {
    uniqueLocalNoTmdb: 0,
    exactYear: 0,
    noSlugYear: 0,
    yearCompatiblePlusMinus1: 0,
    yearMismatchGt1: 0,
    missingLocalReleaseYear: 0,
  };

  const candidateGeometry = {
    topSimilarityGte098: 0,
    topSimilarityGte095: 0,
    topSimilarityGte090: 0,
    topSimilarityGte085: 0,
    topMarginGte014: 0,
    topMarginGte010: 0,
    topMarginGte008: 0,
    exactTitleMultipleCandidates: 0,
    exactTitleMultipleButUniqueExactYear: 0,
  };

  const experimentalBuckets = {
    uniqueLocalNoTmdbExactYear: 0,
    uniqueLocalNoTmdbNoYear: 0,
    fuzzyExactYearSimilarityGte090MarginGte008: 0,
    fuzzyYearCompatibleSimilarityGte095MarginGte012: 0,
    noYearSimilarity095To098MarginGte012: 0,
  };

  for (const record of pending) {
    const v1 = record?.matchV1 || {};
    inc(byV1Status, v1.status);
    inc(byV1Method, v1.method);
    inc(byV2Method, record?.match?.method);

    if (v1.status === 'REVIEW') counts.review += 1;
    if (v1.status === 'UNMATCHED') counts.unmatched += 1;

    const slugYear = Number(record?.slug?.year) || null;
    if (slugYear) counts.withSlugYear += 1;
    else counts.withoutSlugYear += 1;

    const tmdbCandidates = Array.isArray(record?.tmdb?.candidates)
      ? record.tmdb.candidates.filter((item) => Number.isFinite(Number(item?.id)))
      : [];
    if (tmdbCandidates.length) counts.withTmdbCandidates += 1;
    else counts.withoutTmdbCandidates += 1;

    const localCandidates = Array.isArray(record?.local?.candidates)
      ? record.local.candidates
      : [];
    if (localCandidates.length) counts.withLocalCandidates += 1;
    if (localCandidates.length === 1) counts.withUniqueLocalCandidate += 1;
    if (localCandidates.length > 1) counts.withMultipleLocalCandidates += 1;

    const slugTokens = new Set(normalize(record?.slug?.titleRaw).split(' ').filter(Boolean));
    for (const token of Object.keys(noiseTokens)) {
      if (slugTokens.has(token)) noiseTokens[token] += 1;
    }

    if (localCandidates.length === 1 && tmdbCandidates.length === 0) {
      localOnly.uniqueLocalNoTmdb += 1;
      const localYear = Number(localCandidates[0]?.releaseYear) || null;
      if (!slugYear) {
        localOnly.noSlugYear += 1;
        experimentalBuckets.uniqueLocalNoTmdbNoYear += 1;
      } else if (!localYear) {
        localOnly.missingLocalReleaseYear += 1;
      } else {
        const delta = Math.abs(slugYear - localYear);
        if (delta === 0) {
          localOnly.exactYear += 1;
          experimentalBuckets.uniqueLocalNoTmdbExactYear += 1;
        }
        if (delta <= 1) localOnly.yearCompatiblePlusMinus1 += 1;
        if (delta > 1) localOnly.yearMismatchGt1 += 1;
      }
    }

    if (tmdbCandidates.length === 0) continue;

    const metrics = candidateMetrics(record);
    const first = metrics.first;
    if (!first) continue;

    if (first.titleSim >= 0.98) candidateGeometry.topSimilarityGte098 += 1;
    if (first.titleSim >= 0.95) candidateGeometry.topSimilarityGte095 += 1;
    if (first.titleSim >= 0.90) candidateGeometry.topSimilarityGte090 += 1;
    if (first.titleSim >= 0.85) candidateGeometry.topSimilarityGte085 += 1;
    if ((metrics.margin ?? 0) >= 0.14) candidateGeometry.topMarginGte014 += 1;
    if ((metrics.margin ?? 0) >= 0.10) candidateGeometry.topMarginGte010 += 1;
    if ((metrics.margin ?? 0) >= 0.08) candidateGeometry.topMarginGte008 += 1;
    if (metrics.exactCount > 1) candidateGeometry.exactTitleMultipleCandidates += 1;
    if (metrics.exactCount > 1 && metrics.exactYearCount === 1) {
      candidateGeometry.exactTitleMultipleButUniqueExactYear += 1;
    }

    if (
      metrics.slugYear &&
      first.candidateYear === metrics.slugYear &&
      first.titleSim >= 0.90 &&
      (metrics.margin ?? 0) >= 0.08
    ) {
      experimentalBuckets.fuzzyExactYearSimilarityGte090MarginGte008 += 1;
    }

    if (
      metrics.slugYear &&
      first.yearDelta !== null &&
      first.yearDelta <= 1 &&
      first.titleSim >= 0.95 &&
      (metrics.margin ?? 0) >= 0.12
    ) {
      experimentalBuckets.fuzzyYearCompatibleSimilarityGte095MarginGte012 += 1;
    }

    if (
      !metrics.slugYear &&
      first.titleSim >= 0.95 &&
      first.titleSim < 0.98 &&
      (metrics.margin ?? 0) >= 0.12
    ) {
      experimentalBuckets.noYearSimilarity095To098MarginGte012 += 1;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_PENDING_V3_AUDIT',
    databaseWrites: false,
    externalRequests: false,
    rawTitlesStored: false,
    rawUrlsStored: false,
    source: path.relative(process.cwd(), inputFile),
    counts,
    byV1Status,
    byV1Method,
    byV2Method,
    localOnly,
    candidateGeometry,
    experimentalBuckets,
    slugNoiseTokenHits: noiseTokens,
    interpretation: {
      uniqueLocalNoTmdb: 'Exact normalized local-title anchors that V1 left unmatched because TMDB search returned no candidates.',
      experimentalBuckets: 'Sizing only. These are not approved automatic promotions.',
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialPendingV3Audit] Complete');
  console.log('  pending records                  : ' + counts.pendingRecords);
  console.log('  REVIEW                           : ' + counts.review);
  console.log('  UNMATCHED                        : ' + counts.unmatched);
  console.log('  unique local + no TMDB candidate : ' + localOnly.uniqueLocalNoTmdb);
  console.log('    exact year                     : ' + localOnly.exactYear);
  console.log('    no slug year                   : ' + localOnly.noSlugYear);
  console.log('  TMDB candidate records           : ' + counts.withTmdbCandidates);
  console.log('  no TMDB candidate records        : ' + counts.withoutTmdbCandidates);
  console.log('  database writes                  : false');
  console.log('  external requests                : false');
  console.log('  summary                          : ' + SUMMARY_FILE);
};

main();
