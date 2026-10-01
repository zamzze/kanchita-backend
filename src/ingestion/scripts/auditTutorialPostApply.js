'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const PROVIDER_ID = process.env.TUTORIAL_PROVIDER_ID || 'tutorial_catalog';
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-post-apply -- ' +
      '<tutorial-movie-matcher-v1-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error('Input file not found: ' + inputFile);
  }

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const auto = (input.records || []).filter((record) =>
    record?.match?.status === 'AUTO_MATCH' &&
    Number.isFinite(Number(record?.match?.selectedTmdbId))
  );

  const expectedByUrl = new Map(
    auto.map((record) => [record.tutorialUrl, Number(record.match.selectedTmdbId)])
  );
  const tutorialUrls = [...expectedByUrl.keys()];

  let found = 0;
  let matched = 0;
  let movieMapped = 0;
  let tmdbMatches = 0;
  let missingMovie = 0;
  let wrongTmdb = 0;
  let missingActiveServers = 0;
  let activeServers = 0;
  let publishedMovies = 0;
  let unpublishedMovies = 0;
  const mappedMovieIds = new Set();

  for (let offset = 0; offset < tutorialUrls.length; offset += 750) {
    const chunk = tutorialUrls.slice(offset, offset + 750);
    const sql =
      'SELECT sci.tutorial_url, sci.match_status, sci.mapped_content_type, ' +
      'sci.mapped_content_id, sci.tmdb_id AS item_tmdb_id, ' +
      'm.id AS movie_id, m.tmdb_id AS movie_tmdb_id, m.is_published, ' +
      'COUNT(scs.id) FILTER (WHERE scs.is_active = TRUE)::int AS active_servers ' +
      'FROM source_catalog_items sci ' +
      'LEFT JOIN movies m ON sci.mapped_content_type = \'movie\' ' +
      'AND m.id = sci.mapped_content_id ' +
      'LEFT JOIN source_catalog_servers scs ON scs.catalog_item_id = sci.id ' +
      'WHERE sci.provider_id = $1 AND sci.tutorial_url = ANY($2::text[]) ' +
      'GROUP BY sci.id, sci.tutorial_url, sci.match_status, ' +
      'sci.mapped_content_type, sci.mapped_content_id, sci.tmdb_id, ' +
      'm.id, m.tmdb_id, m.is_published';

    const { rows } = await pool.query(sql, [PROVIDER_ID, chunk]);
    const byUrl = new Map(rows.map((row) => [row.tutorial_url, row]));

    for (const tutorialUrl of chunk) {
      const row = byUrl.get(tutorialUrl);
      if (!row) continue;
      found += 1;

      if (row.match_status === 'matched') matched += 1;
      if (row.mapped_content_type === 'movie' && row.mapped_content_id) {
        movieMapped += 1;
      }

      const expectedTmdbId = expectedByUrl.get(tutorialUrl);
      if (!row.movie_id) {
        missingMovie += 1;
      } else {
        mappedMovieIds.add(String(row.movie_id));
        if (Number(row.movie_tmdb_id) === expectedTmdbId &&
            Number(row.item_tmdb_id) === expectedTmdbId) {
          tmdbMatches += 1;
        } else {
          wrongTmdb += 1;
        }
      }

      const servers = Number(row.active_servers || 0);
      activeServers += servers;
      if (servers === 0) missingActiveServers += 1;

      if (row.is_published === true) publishedMovies += 1;
      if (row.is_published === false) unpublishedMovies += 1;
    }
  }

  const uniqueExpectedTmdbIds = new Set(
    auto.map((record) => Number(record.match.selectedTmdbId))
  ).size;

  const integrityOk =
    found === auto.length &&
    matched === auto.length &&
    movieMapped === auto.length &&
    tmdbMatches === auto.length &&
    missingMovie === 0 &&
    wrongTmdb === 0 &&
    missingActiveServers === 0 &&
    mappedMovieIds.size === uniqueExpectedTmdbIds;

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_POST_APPLY_AUDIT',
    databaseWrites: false,
    expected: {
      autoMatchTutorials: auto.length,
      uniqueTmdbIds: uniqueExpectedTmdbIds,
    },
    mapping: {
      sourceItemsFound: found,
      matchStatusMatched: matched,
      movieMapped,
      tmdbIdentityMatches: tmdbMatches,
      missingMovie,
      wrongTmdb,
      uniqueMappedMovies: mappedMovieIds.size,
    },
    sources: {
      activeServers,
      mappedItemsWithoutActiveServer: missingActiveServers,
    },
    publicationObservation: {
      mappedTutorialRowsPointingToPublishedMovies: publishedMovies,
      mappedTutorialRowsPointingToUnpublishedMovies: unpublishedMovies,
      note: 'Counts are tutorial rows, not unique movies.',
    },
    integrity: {
      ok: integrityOk,
      recommendation: integrityOk
        ? 'POST_APPLY_INTEGRITY_OK'
        : 'POST_APPLY_INTEGRITY_REVIEW_REQUIRED',
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-post-apply-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialPostApplyAudit] Complete');
  console.log('  expected tutorials      : ' + auto.length);
  console.log('  source items found      : ' + found);
  console.log('  matched                 : ' + matched);
  console.log('  movie mapped            : ' + movieMapped);
  console.log('  TMDB identity matches   : ' + tmdbMatches);
  console.log('  unique mapped movies    : ' + mappedMovieIds.size);
  console.log('  active servers          : ' + activeServers);
  console.log('  items without servers   : ' + missingActiveServers);
  console.log('  integrity OK            : ' + integrityOk);
  console.log('  summary                 : ' + output);
};

main()
  .catch((error) => {
    console.error('[TutorialPostApplyAudit] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
