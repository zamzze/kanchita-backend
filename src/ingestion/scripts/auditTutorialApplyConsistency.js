'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-apply-consistency -- ' +
      '<tutorial-movie-matcher-v1-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error('Input file not found: ' + inputFile);
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const auto = (input.records || []).filter((record) =>
    record?.match?.status === 'AUTO_MATCH' &&
    Number.isFinite(Number(record?.match?.selectedTmdbId))
  );

  const withLocalMovieId = auto.filter((record) =>
    Boolean(record?.match?.localMovieId)
  );

  const localIds = [...new Set(
    withLocalMovieId.map((record) => String(record.match.localMovieId))
  )];

  const localRowsById = new Map();
  for (let offset = 0; offset < localIds.length; offset += 1000) {
    const chunk = localIds.slice(offset, offset + 1000);
    const sql =
      'SELECT id, tmdb_id, is_published FROM movies ' +
      'WHERE id = ANY($1::uuid[])';
    const { rows } = await pool.query(sql, [chunk]);
    for (const row of rows) localRowsById.set(String(row.id), row);
  }

  const selectedTmdbIds = [...new Set(
    auto.map((record) => Number(record.match.selectedTmdbId))
  )];

  const rowsByTmdb = new Map();
  for (let offset = 0; offset < selectedTmdbIds.length; offset += 1000) {
    const chunk = selectedTmdbIds.slice(offset, offset + 1000);
    const sql =
      'SELECT id, tmdb_id, is_published FROM movies ' +
      'WHERE tmdb_id = ANY($1::int[])';
    const { rows } = await pool.query(sql, [chunk]);
    for (const row of rows) rowsByTmdb.set(Number(row.tmdb_id), row);
  }

  const counts = {
    localMovieIdRecords: withLocalMovieId.length,
    uniqueLocalMovieIds: localIds.length,
    localMovieIdExistsAndTmdbMatches: 0,
    localMovieIdExistsButTmdbNull: 0,
    localMovieIdExistsButTmdbDiffers: 0,
    localMovieIdMissing: 0,
    selectedTmdbExistsSameUuid: 0,
    selectedTmdbExistsDifferentUuid: 0,
    selectedTmdbMissing: 0,
  };

  const privateRecords = [];

  for (const record of withLocalMovieId) {
    const localMovieId = String(record.match.localMovieId);
    const selectedTmdbId = Number(record.match.selectedTmdbId);
    const localRow = localRowsById.get(localMovieId) || null;
    const tmdbRow = rowsByTmdb.get(selectedTmdbId) || null;

    let localState;
    if (!localRow) {
      localState = 'LOCAL_UUID_MISSING';
      counts.localMovieIdMissing += 1;
    } else if (localRow.tmdb_id === null || localRow.tmdb_id === undefined) {
      localState = 'LOCAL_UUID_TMDB_NULL';
      counts.localMovieIdExistsButTmdbNull += 1;
    } else if (Number(localRow.tmdb_id) === selectedTmdbId) {
      localState = 'LOCAL_UUID_TMDB_MATCH';
      counts.localMovieIdExistsAndTmdbMatches += 1;
    } else {
      localState = 'LOCAL_UUID_TMDB_DIFFERENT';
      counts.localMovieIdExistsButTmdbDiffers += 1;
    }

    let tmdbState;
    if (!tmdbRow) {
      tmdbState = 'SELECTED_TMDB_MISSING';
      counts.selectedTmdbMissing += 1;
    } else if (String(tmdbRow.id) === localMovieId) {
      tmdbState = 'SELECTED_TMDB_SAME_UUID';
      counts.selectedTmdbExistsSameUuid += 1;
    } else {
      tmdbState = 'SELECTED_TMDB_DIFFERENT_UUID';
      counts.selectedTmdbExistsDifferentUuid += 1;
    }

    privateRecords.push({
      tutorialUrl: record.tutorialUrl,
      matchMethod: record.match.method,
      selectedTmdbId,
      matcherLocalMovieId: localMovieId,
      localState,
      currentLocalTmdbId: localRow?.tmdb_id ?? null,
      selectedTmdbCurrentMovieId: tmdbRow?.id ?? null,
      tmdbState,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_CONSISTENCY_AUDIT',
    privacy: {
      rawUrlsStoredInSummary: false,
      rawTitlesStoredInSummary: false,
      privateOutputContainsRealValues: true,
      externalApiRequests: false,
      databaseWrites: false,
    },
    population: {
      autoMatchRecords: auto.length,
      uniqueSelectedTmdbIds: selectedTmdbIds.length,
      currentMoviesForSelectedTmdbIds: rowsByTmdb.size,
    },
    consistency: counts,
    recommendation: null,
  };

  if (
    counts.localMovieIdMissing === 0 &&
    counts.localMovieIdExistsButTmdbNull === 0 &&
    counts.localMovieIdExistsButTmdbDiffers === 0 &&
    counts.selectedTmdbExistsDifferentUuid === 0
  ) {
    summary.recommendation = 'CONSISTENT_SAFE_TO_BUILD_APPLY';
  } else if (counts.selectedTmdbExistsDifferentUuid > 0) {
    summary.recommendation = 'UUID_TMDB_IDENTITY_CONFLICT_REVIEW_REQUIRED';
  } else if (counts.localMovieIdMissing > 0) {
    summary.recommendation = 'MATCHER_LOCAL_UUIDS_NOT_PRESENT_IN_CURRENT_DB';
  } else {
    summary.recommendation = 'LOCAL_TMDB_IDENTITY_DRIFT_REVIEW_REQUIRED';
  }

  const privateFile = path.join(
    PRIVATE_DIR,
    'tutorial-apply-consistency-private.json'
  );
  const summaryFile = path.join(
    REPORT_DIR,
    'tutorial-apply-consistency-summary.json'
  );

  fs.writeFileSync(
    privateFile,
    JSON.stringify({
      generatedAt: summary.generatedAt,
      records: privateRecords,
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialApplyConsistencyAudit] Complete');
  console.log('  AUTO_MATCH records       : ' + auto.length);
  console.log('  matcher local IDs        : ' + withLocalMovieId.length);
  console.log('  unique local IDs         : ' + localIds.length);
  console.log('  local UUID + TMDB match  : ' + counts.localMovieIdExistsAndTmdbMatches);
  console.log('  local UUID TMDB null     : ' + counts.localMovieIdExistsButTmdbNull);
  console.log('  local UUID TMDB differs  : ' + counts.localMovieIdExistsButTmdbDiffers);
  console.log('  local UUID missing       : ' + counts.localMovieIdMissing);
  console.log('  selected TMDB same UUID  : ' + counts.selectedTmdbExistsSameUuid);
  console.log('  selected TMDB other UUID : ' + counts.selectedTmdbExistsDifferentUuid);
  console.log('  selected TMDB missing    : ' + counts.selectedTmdbMissing);
  console.log('  recommendation           : ' + summary.recommendation);
  console.log('  safe summary             : ' + summaryFile);
};

main()
  .catch((error) => {
    console.error('[TutorialApplyConsistencyAudit] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
