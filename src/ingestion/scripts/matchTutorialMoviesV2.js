'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const inputArg = argv.find((arg) => !arg.startsWith('--'));

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const FULL_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-matcher-v2-latest.json');
const PROMOTIONS_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-matcher-v2-promotions.json');
const SUMMARY_FILE = path.join(REPORT_DIR, 'tutorial-movie-matcher-v2-summary.json');

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
  for (let index = 0; index < text.length - 1; index += 1) {
    output.push(text.slice(index, index + 2));
  }
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

const candidateScore = (record, candidate) => {
  const slugTitle = record?.slug?.normalizedTitle || normalize(record?.slug?.titleRaw);
  const candidateTitle = normalize(candidate?.title);
  const candidateOriginal = normalize(candidate?.originalTitle);
  const titleSimilarity = Math.max(
    similarity(slugTitle, candidateTitle),
    similarity(slugTitle, candidateOriginal)
  );
  const exactTitle = Boolean(slugTitle) &&
    (slugTitle === candidateTitle || slugTitle === candidateOriginal);
  const slugYear = Number(record?.slug?.year) || null;
  const candidateYear = releaseYear(candidate?.releaseDate);
  const yearDelta = slugYear && candidateYear ? Math.abs(slugYear - candidateYear) : null;
  const yearExact = yearDelta === 0;
  const yearCompatible = yearDelta === null || yearDelta <= 1;

  const localCandidates = Array.isArray(record?.local?.candidates)
    ? record.local.candidates : [];
  const localHit = localCandidates.find((item) =>
    Number(item?.tmdbId) === Number(candidate?.id)
  ) || null;

  let score = titleSimilarity * 100;
  if (exactTitle) score += 10;
  if (slugYear && candidateYear) {
    if (yearExact) score += 12;
    else if (yearDelta === 1) score += 4;
    else score -= Math.min(35, yearDelta * 8);
  }
  if (localHit) score += 15;

  return {
    candidate,
    titleSimilarity,
    exactTitle,
    slugYear,
    candidateYear,
    yearDelta,
    yearExact,
    yearCompatible,
    localHit,
    score: Number(score.toFixed(2)),
  };
};

const classify = (record) => {
  if (record?.match?.status === 'AUTO_MATCH') {
    return { action: 'KEEP_V1_AUTO', promoted: false, decision: null };
  }

  const candidates = Array.isArray(record?.tmdb?.candidates)
    ? record.tmdb.candidates.filter((item) => Number.isFinite(Number(item?.id)))
    : [];
  if (!candidates.length) {
    return {
      action: 'KEEP_PENDING',
      promoted: false,
      decision: {
        status: record?.match?.status || 'UNMATCHED',
        method: 'v2_no_candidates',
        score: 0,
        selectedTmdbId: null,
        localMovieId: null,
        reasons: ['v1_has_no_tmdb_candidates'],
      },
    };
  }

  const ranked = candidates
    .map((candidate) => candidateScore(record, candidate))
    .sort((a, b) => b.score - a.score || Number(a.candidate.id) - Number(b.candidate.id));
  const first = ranked[0];
  const second = ranked[1] || null;
  const margin = second ? first.score - second.score : first.score;
  const uniqueLocal = ranked.filter((item) => item.localHit).length === 1;
  const slugHasYear = Boolean(first.slugYear);

  let method = null;
  let reasons = [];

  if (
    uniqueLocal &&
    first.localHit &&
    first.exactTitle &&
    first.yearCompatible &&
    margin >= 8
  ) {
    method = 'v2_unique_local_anchor';
    reasons = [
      'single_local_tmdb_anchor',
      'exact_normalized_title',
      'year_compatible',
      'candidate_margin_gte_8',
    ];
  } else if (
    slugHasYear &&
    first.yearExact &&
    first.titleSimilarity >= 0.92 &&
    margin >= 10
  ) {
    method = 'v2_high_similarity_exact_year';
    reasons = [
      'title_similarity_gte_0_92',
      'exact_release_year',
      'candidate_margin_gte_10',
    ];
  } else if (
    !slugHasYear &&
    first.titleSimilarity >= 0.98 &&
    margin >= 14
  ) {
    method = 'v2_very_high_similarity_no_year';
    reasons = [
      'title_similarity_gte_0_98',
      'candidate_margin_gte_14',
    ];
  }

  if (!method) {
    return {
      action: 'KEEP_PENDING',
      promoted: false,
      ranked,
      decision: {
        status: record?.match?.status || 'REVIEW',
        method: 'v2_insufficient_evidence',
        score: Number(first.score.toFixed(2)),
        selectedTmdbId: null,
        localMovieId: null,
        reasons: [
          'conservative_threshold_not_met',
          'top_similarity=' + first.titleSimilarity,
          'top_margin=' + Number(margin.toFixed(2)),
        ],
      },
    };
  }

  return {
    action: 'PROMOTE_AUTO_MATCH',
    promoted: true,
    ranked,
    decision: {
      status: 'AUTO_MATCH',
      method,
      score: Number(first.score.toFixed(2)),
      selectedTmdbId: Number(first.candidate.id),
      localMovieId: first.localHit?.id || null,
      reasons,
      v1Status: record?.match?.status || null,
      v1Method: record?.match?.method || null,
      candidateMargin: Number(margin.toFixed(2)),
      titleSimilarity: first.titleSimilarity,
      slugYear: first.slugYear,
      candidateYear: first.candidateYear,
    },
  };
};

const writeJsonAtomic = (file, value) => {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run match:tutorial-movies:v2 -- ' +
      '<tutorial-movie-matcher-v1-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) throw new Error('Input file not found: ' + inputFile);

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = Array.isArray(input.records) ? input.records : [];
  const outputRecords = [];
  const promotions = [];
  const counts = {
    totalInput: records.length,
    v1AutoUntouched: 0,
    pendingEvaluated: 0,
    promotedToAuto: 0,
    stillReview: 0,
    stillUnmatched: 0,
  };
  const byPromotionMethod = {};

  for (const record of records) {
    const result = classify(record);
    if (result.action === 'KEEP_V1_AUTO') {
      counts.v1AutoUntouched += 1;
      continue;
    }

    counts.pendingEvaluated += 1;
    const upgraded = {
      ...record,
      matchV1: record.match,
      match: result.decision,
    };
    outputRecords.push(upgraded);

    if (result.promoted) {
      counts.promotedToAuto += 1;
      promotions.push(upgraded);
      byPromotionMethod[result.decision.method] =
        (byPromotionMethod[result.decision.method] || 0) + 1;
    } else if (record?.match?.status === 'UNMATCHED') {
      counts.stillUnmatched += 1;
    } else {
      counts.stillReview += 1;
    }
  }

  const fullOutput = {
    generatedAt: new Date().toISOString(),
    mode: 'DRY_RUN_READ_ONLY_V2',
    source: path.relative(process.cwd(), inputFile),
    records: outputRecords,
  };
  const promotionsOutput = {
    generatedAt: new Date().toISOString(),
    mode: 'V2_PROMOTIONS_ONLY',
    source: path.relative(process.cwd(), inputFile),
    records: promotions,
  };
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'DRY_RUN_READ_ONLY_V2',
    databaseWrites: false,
    externalApiRequests: false,
    policy: {
      v1AutoRecordsUntouched: true,
      onlyReviewAndUnmatchedEvaluated: true,
      conservativePromotionThresholds: true,
      publicationChanges: false,
    },
    counts,
    byPromotionMethod,
    outputs: {
      fullPrivate: path.relative(process.cwd(), FULL_FILE),
      promotionsPrivate: path.relative(process.cwd(), PROMOTIONS_FILE),
    },
  };

  writeJsonAtomic(FULL_FILE, fullOutput);
  writeJsonAtomic(PROMOTIONS_FILE, promotionsOutput);
  writeJsonAtomic(SUMMARY_FILE, summary);

  console.log('[TutorialMovieMatcherV2] Complete');
  console.log('  V1 AUTO untouched  : ' + counts.v1AutoUntouched);
  console.log('  pending evaluated  : ' + counts.pendingEvaluated);
  console.log('  promoted to AUTO   : ' + counts.promotedToAuto);
  console.log('  still REVIEW       : ' + counts.stillReview);
  console.log('  still UNMATCHED    : ' + counts.stillUnmatched);
  console.log('  database writes    : false');
  console.log('  external requests  : false');
  console.log('  summary            : ' + SUMMARY_FILE);
  console.log('  promotions         : ' + PROMOTIONS_FILE);
};

main().catch((error) => {
  console.error('[TutorialMovieMatcherV2] ' + error.message);
  process.exitCode = 1;
});
