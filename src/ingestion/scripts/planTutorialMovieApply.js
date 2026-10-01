'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const PROVIDER_ID = process.env.TUTORIAL_PROVIDER_ID || 'tutorial_catalog';

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run plan:tutorial-movie-apply -- ' +
      '<tutorial-movie-matcher-v1-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error('Input file not found: ' + inputFile);
  }

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = input.records || [];
  const auto = records.filter((record) =>
    record?.match?.status === 'AUTO_MATCH' &&
    Number.isFinite(Number(record?.match?.selectedTmdbId))
  );

  const tmdbGroups = new Map();
  for (const record of auto) {
    const tmdbId = Number(record.match.selectedTmdbId);
    if (!tmdbGroups.has(tmdbId)) tmdbGroups.set(tmdbId, []);
    tmdbGroups.get(tmdbId).push(record);
  }

  const tmdbIds = [...tmdbGroups.keys()];
  const existingByTmdb = new Map();

  if (tmdbIds.length) {
    const sql =
      'SELECT id, tmdb_id, title, is_published ' +
      'FROM movies WHERE tmdb_id = ANY($1::int[])';
    const { rows } = await pool.query(sql, [tmdbIds]);
    for (const row of rows) {
      existingByTmdb.set(Number(row.tmdb_id), row);
    }
  }

  const tutorialUrls = auto.map((record) => record.tutorialUrl);
  const sourceItemsByUrl = new Map();

  for (let offset = 0; offset < tutorialUrls.length; offset += 1000) {
    const chunk = tutorialUrls.slice(offset, offset + 1000);
    if (!chunk.length) continue;

    const sql =
      'SELECT id, tutorial_url, match_status, mapped_content_type, ' +
      'mapped_content_id, tmdb_id, fetch_status, server_count ' +
      'FROM source_catalog_items ' +
      'WHERE provider_id = $1 AND tutorial_url = ANY($2::text[])';

    const { rows } = await pool.query(sql, [PROVIDER_ID, chunk]);
    for (const row of rows) {
      sourceItemsByUrl.set(row.tutorial_url, row);
    }
  }

  let duplicateTmdbGroups = 0;
  let duplicateTutorials = 0;
  let existingMovies = 0;
  let newMovies = 0;
  let sourceItemsFound = 0;
  let sourceItemsMissing = 0;
  let alreadyMapped = 0;
  let mappingConflicts = 0;
  let declaredCandidateServers = 0;

  const privatePlan = [];

  for (const [tmdbId, group] of tmdbGroups.entries()) {
    const existingMovie = existingByTmdb.get(tmdbId) || null;
    if (existingMovie) existingMovies += 1;
    else newMovies += 1;

    if (group.length > 1) {
      duplicateTmdbGroups += 1;
      duplicateTutorials += group.length;
    }

    for (const record of group) {
      const item = sourceItemsByUrl.get(record.tutorialUrl) || null;

      if (item) {
        sourceItemsFound += 1;
        declaredCandidateServers += Number(item.server_count || 0);

        if (item.mapped_content_id) {
          alreadyMapped += 1;
          const expectedMovieId =
            existingMovie?.id || record?.match?.localMovieId || null;

          if (
            expectedMovieId &&
            (
              item.mapped_content_type !== 'movie' ||
              String(item.mapped_content_id) !== String(expectedMovieId)
            )
          ) {
            mappingConflicts += 1;
          }
        }
      } else {
        sourceItemsMissing += 1;
      }

      privatePlan.push({
        tutorialUrl: record.tutorialUrl,
        matchMethod: record.match.method,
        matchScore: record.match.score,
        selectedTmdbId: tmdbId,
        matcherLocalMovieId: record.match.localMovieId || null,
        movie: existingMovie
          ? {
              id: existingMovie.id,
              tmdbId: existingMovie.tmdb_id,
              title: existingMovie.title,
              isPublished: existingMovie.is_published,
              action: 'reuse',
            }
          : {
              id: null,
              tmdbId,
              action: 'create_from_tmdb_detail',
            },
        sourceCatalog: item
          ? {
              id: item.id,
              fetchStatus: item.fetch_status,
              serverCount: Number(item.server_count || 0),
              currentMatchStatus: item.match_status,
              mappedContentType: item.mapped_content_type,
              mappedContentId: item.mapped_content_id,
              currentTmdbId: item.tmdb_id,
              action: item.mapped_content_id
                ? 'verify_existing_mapping'
                : 'map',
            }
          : {
              id: null,
              action: 'missing_source_catalog_item',
            },
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_APPLY_PLAN',
    privacy: {
      rawUrlsStoredInSummary: false,
      rawTitlesStoredInSummary: false,
      privatePlanContainsRealValues: true,
      externalApiRequests: false,
      databaseWrites: false,
    },
    matcher: {
      totalRecords: records.length,
      autoMatchRecords: auto.length,
      uniqueTmdbIds: tmdbGroups.size,
    },
    deduplication: {
      tmdbIdsWithMultipleTutorials: duplicateTmdbGroups,
      tutorialsInsideDuplicateTmdbGroups: duplicateTutorials,
    },
    movies: {
      existingUniqueTmdbIds: existingMovies,
      newUniqueTmdbIdsToCreate: newMovies,
    },
    sourceCatalog: {
      providerId: PROVIDER_ID,
      autoMatchItemsFound: sourceItemsFound,
      autoMatchItemsMissing: sourceItemsMissing,
      alreadyMapped,
      mappingConflicts,
      declaredCandidateServers,
    },
    readiness: {
      canApply: sourceItemsMissing === 0 && mappingConflicts === 0,
      blockers: [
        ...(sourceItemsMissing ? ['SOURCE_CATALOG_ITEMS_MISSING'] : []),
        ...(mappingConflicts ? ['EXISTING_MAPPING_CONFLICTS'] : []),
      ],
    },
  };

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(
    PRIVATE_DIR,
    'tutorial-movie-apply-plan-private.json'
  );
  const summaryFile = path.join(
    REPORT_DIR,
    'tutorial-movie-apply-plan-summary.json'
  );

  fs.writeFileSync(
    privateFile,
    JSON.stringify({
      generatedAt: summary.generatedAt,
      records: privatePlan,
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialMovieApplyPlan] Complete');
  console.log('  matcher records         : ' + records.length);
  console.log('  AUTO_MATCH tutorials    : ' + auto.length);
  console.log('  unique TMDB movies      : ' + tmdbGroups.size);
  console.log('  duplicate TMDB groups   : ' + duplicateTmdbGroups);
  console.log('  existing movies         : ' + existingMovies);
  console.log('  new movies to create    : ' + newMovies);
  console.log('  source items found      : ' + sourceItemsFound);
  console.log('  source items missing    : ' + sourceItemsMissing);
  console.log('  mapping conflicts       : ' + mappingConflicts);
  console.log('  candidate servers       : ' + declaredCandidateServers);
  console.log('  can apply               : ' + summary.readiness.canApply);
  console.log('  private plan            : ' + privateFile);
  console.log('  safe summary            : ' + summaryFile);
};

main()
  .catch((error) => {
    console.error('[TutorialMovieApplyPlan] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
