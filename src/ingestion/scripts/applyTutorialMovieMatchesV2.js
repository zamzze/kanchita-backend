'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const tmdbFetcher = require('../tmdb/tmdbFetcher');
const { normalizeMovie } = require('../normalizer/movieNormalizer');

const argv = process.argv.slice(2);
const inputArg = argv.find((arg) => !arg.startsWith('--'));
const APPLY = argv.includes('--apply');
const PROVIDER_ID = process.env.TUTORIAL_PROVIDER_ID || 'tutorial_catalog';
const DELAY_MS = Math.max(0, Number.parseInt(process.env.TUTORIAL_APPLY_TMDB_DELAY_MS || '175', 10));
const RETRIES = Math.max(0, Number.parseInt(process.env.TUTORIAL_APPLY_TMDB_RETRIES || '2', 10));

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const CACHE_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-apply-tmdb-cache.json');
const CHECKPOINT_FILE = path.join(PRIVATE_DIR, 'tutorial-movie-apply-v2-checkpoint.json');
const SUMMARY_FILE = path.join(REPORT_DIR, 'tutorial-movie-apply-v2-summary.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJsonAtomic = (file, value) => {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
};
const withRetry = async (fn) => {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (attempt < RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
};

const loadExistingMovies = async (tmdbIds) => {
  const byTmdb = new Map();
  for (let offset = 0; offset < tmdbIds.length; offset += 1000) {
    const chunk = tmdbIds.slice(offset, offset + 1000);
    const { rows } = await pool.query(
      'SELECT id, tmdb_id, is_published FROM movies WHERE tmdb_id = ANY($1::int[])',
      [chunk]
    );
    for (const row of rows) byTmdb.set(Number(row.tmdb_id), row);
  }
  return byTmdb;
};

const loadSourceItems = async (tutorialUrls) => {
  const byUrl = new Map();
  for (let offset = 0; offset < tutorialUrls.length; offset += 1000) {
    const chunk = tutorialUrls.slice(offset, offset + 1000);
    const { rows } = await pool.query(
      `SELECT sci.id, sci.tutorial_url, sci.fetch_status, sci.match_status,
              sci.mapped_content_type, sci.mapped_content_id, sci.tmdb_id,
              mapped_movie.tmdb_id AS mapped_movie_tmdb_id
       FROM source_catalog_items sci
       LEFT JOIN movies mapped_movie
         ON sci.mapped_content_type = 'movie'
        AND mapped_movie.id = sci.mapped_content_id
       WHERE sci.provider_id = $1
         AND sci.tutorial_url = ANY($2::text[])`,
      [PROVIDER_ID, chunk]
    );
    for (const row of rows) byUrl.set(row.tutorial_url, row);
  }
  return byUrl;
};

const validateLocalAnchors = async (records) => {
  const anchored = records.filter((record) => Boolean(record?.match?.localMovieId));
  const ids = [...new Set(anchored.map((record) => String(record.match.localMovieId)))];
  if (!ids.length) return { anchored: 0, conflicts: 0 };

  const byId = new Map();
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const chunk = ids.slice(offset, offset + 1000);
    const { rows } = await pool.query(
      'SELECT id, tmdb_id FROM movies WHERE id = ANY($1::uuid[])',
      [chunk]
    );
    for (const row of rows) byId.set(String(row.id), row);
  }

  let conflicts = 0;
  for (const record of anchored) {
    const row = byId.get(String(record.match.localMovieId));
    if (!row || Number(row.tmdb_id) !== Number(record.match.selectedTmdbId)) conflicts += 1;
  }
  return { anchored: anchored.length, conflicts };
};

const insertMovieIfMissing = async (client, normalized) => {
  const { rows } = await client.query(
    `INSERT INTO movies
       (tmdb_id, title, original_title, description, release_year,
        duration_seconds, poster_url, backdrop_url, rating, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)
     ON CONFLICT (tmdb_id) DO NOTHING
     RETURNING id, tmdb_id, is_published`,
    [
      normalized.tmdb_id, normalized.title, normalized.original_title,
      normalized.description, normalized.release_year, normalized.duration_seconds,
      normalized.poster_url, normalized.backdrop_url, normalized.rating,
    ]
  );
  if (rows[0]) return { movie: rows[0], inserted: true };
  const existing = await client.query(
    'SELECT id, tmdb_id, is_published FROM movies WHERE tmdb_id = $1',
    [normalized.tmdb_id]
  );
  if (!existing.rows[0]) throw new Error('Movie upsert race could not be resolved');
  return { movie: existing.rows[0], inserted: false };
};

const upsertGenres = async (client, movieId, genres) => {
  for (const genre of genres || []) {
    const slug = String(genre.name || '')
      .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    await client.query(
      `INSERT INTO genres (id, name, slug)
       VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [genre.id, genre.name, slug]
    );
    await client.query(
      `INSERT INTO content_genres (content_type, content_id, genre_id)
       VALUES ('movie',$1,$2)
       ON CONFLICT (content_type, content_id, genre_id) DO NOTHING`,
      [movieId, genre.id]
    );
  }
};

const mapSourceItem = async (client, record, sourceItem, movieId, tmdbId) => {
  const { rowCount } = await client.query(
    `UPDATE source_catalog_items
     SET match_status = 'matched',
         mapped_content_type = 'movie',
         mapped_content_id = $1,
         tmdb_id = $2,
         updated_at = NOW()
     WHERE id = $3
       AND fetch_status = 'ok'
       AND (
         mapped_content_id IS NULL
         OR (mapped_content_type = 'movie' AND mapped_content_id = $1)
       )`,
    [movieId, tmdbId, sourceItem.id]
  );
  if (rowCount !== 1) {
    throw new Error('Source mapping precondition failed for tutorial promotion');
  }
  return 1;
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run apply:tutorial-movies:v2 -- ' +
      '<tutorial-movie-matcher-v2-promotions.json> [--apply]'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) throw new Error('Input file not found: ' + inputFile);

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = (input.records || []).filter((record) =>
    record?.match?.status === 'AUTO_MATCH' &&
    typeof record?.match?.method === 'string' &&
    record.match.method.startsWith('v2_') &&
    Number.isFinite(Number(record?.match?.selectedTmdbId))
  );

  if (!records.length) throw new Error('No V2 AUTO_MATCH promotions found');
  if (records.length !== (input.records || []).length) {
    throw new Error('Input must contain only V2 AUTO_MATCH promotions');
  }

  const grouped = new Map();
  for (const record of records) {
    const tmdbId = Number(record.match.selectedTmdbId);
    if (!grouped.has(tmdbId)) grouped.set(tmdbId, []);
    grouped.get(tmdbId).push(record);
  }

  const tmdbIds = [...grouped.keys()].sort((a, b) => a - b);
  const existingMovies = await loadExistingMovies(tmdbIds);
  const sourceItems = await loadSourceItems(records.map((record) => record.tutorialUrl));
  const anchorAudit = await validateLocalAnchors(records);

  const missing = records.filter((record) => !sourceItems.has(record.tutorialUrl));
  const sourceConflicts = records.filter((record) => {
    const item = sourceItems.get(record.tutorialUrl);
    if (!item?.mapped_content_id) return false;
    return item.mapped_content_type !== 'movie' ||
      Number(item.mapped_movie_tmdb_id) !== Number(record.match.selectedTmdbId);
  });
  const invalidFetchStatus = records.filter((record) =>
    sourceItems.get(record.tutorialUrl)?.fetch_status !== 'ok'
  );

  const stats = {
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    promotionRecords: records.length,
    uniqueTmdbIds: tmdbIds.length,
    existingMoviesAtStart: existingMovies.size,
    newMoviesNeededAtStart: tmdbIds.length - existingMovies.size,
    localAnchorRecords: anchorAudit.anchored,
    localAnchorConflicts: anchorAudit.conflicts,
    sourceItemsFound: sourceItems.size,
    sourceItemsMissing: missing.length,
    invalidFetchStatus: invalidFetchStatus.length,
    sourceMappingConflicts: sourceConflicts.length,
    newMoviesInsertedThisRun: 0,
    existingMoviesReusedThisRun: 0,
    mappingsAppliedThisRun: 0,
    tmdbDetailNetworkRequests: 0,
    tmdbDetailCacheHits: 0,
    errors: 0,
    newMoviesPublished: 0,
    newMoviesCreatedUnpublished: 0,
  };

  const blocked = missing.length || invalidFetchStatus.length ||
    sourceConflicts.length || anchorAudit.conflicts;

  console.log('[TutorialMovieApplyV2] Starting');
  console.log('  mode                    : ' + stats.mode);
  console.log('  promotion records       : ' + records.length);
  console.log('  unique TMDB movies      : ' + tmdbIds.length);
  console.log('  existing movies         : ' + existingMovies.size);
  console.log('  new movies needed       : ' + stats.newMoviesNeededAtStart);
  console.log('  source items found      : ' + sourceItems.size);
  console.log('  missing source items    : ' + missing.length);
  console.log('  mapping conflicts       : ' + sourceConflicts.length);
  console.log('  local anchor conflicts  : ' + anchorAudit.conflicts);

  if (blocked) {
    writeJsonAtomic(SUMMARY_FILE, {
      generatedAt: new Date().toISOString(), ...stats,
      databaseWrites: false, readyToApply: false,
      publicationPolicy: 'NEW_MOVIES_UNPUBLISHED',
    });
    throw new Error(
      'V2 apply blocked: missing=' + missing.length +
      ', invalidFetch=' + invalidFetchStatus.length +
      ', mappingConflicts=' + sourceConflicts.length +
      ', anchorConflicts=' + anchorAudit.conflicts
    );
  }

  if (!APPLY) {
    writeJsonAtomic(SUMMARY_FILE, {
      generatedAt: new Date().toISOString(), ...stats,
      databaseWrites: false, readyToApply: true,
      publicationPolicy: 'NEW_MOVIES_UNPUBLISHED',
    });
    console.log('  database writes         : false');
    console.log('  ready to apply          : true');
    console.log('  publication policy      : NEW_MOVIES_UNPUBLISHED');
    console.log('  safe summary            : ' + SUMMARY_FILE);
    return;
  }

  const cache = loadJson(CACHE_FILE, {});
  const checkpoint = loadJson(CHECKPOINT_FILE, { completedTutorialUrls: [] });
  const completed = new Set(checkpoint.completedTutorialUrls || []);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (completed.has(record.tutorialUrl)) continue;

    const tmdbId = Number(record.match.selectedTmdbId);
    let movie = existingMovies.get(tmdbId) || null;
    let normalized = null;

    try {
      if (!movie) {
        const cacheKey = String(tmdbId);
        if (cache[cacheKey]) {
          normalized = cache[cacheKey];
          stats.tmdbDetailCacheHits += 1;
        } else {
          const detail = await withRetry(() => tmdbFetcher.getMovieDetail(tmdbId));
          normalized = normalizeMovie(detail);
          normalized.is_published = false;
          cache[cacheKey] = normalized;
          writeJsonAtomic(CACHE_FILE, cache);
          stats.tmdbDetailNetworkRequests += 1;
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (!movie) {
          const result = await insertMovieIfMissing(client, normalized);
          movie = result.movie;
          existingMovies.set(tmdbId, movie);
          if (result.inserted) {
            stats.newMoviesInsertedThisRun += 1;
            stats.newMoviesCreatedUnpublished += 1;
            await upsertGenres(client, movie.id, normalized.genres);
          } else {
            stats.existingMoviesReusedThisRun += 1;
          }
        } else {
          stats.existingMoviesReusedThisRun += 1;
        }

        stats.mappingsAppliedThisRun += await mapSourceItem(
          client, record, sourceItems.get(record.tutorialUrl), movie.id, tmdbId
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      completed.add(record.tutorialUrl);
      writeJsonAtomic(CHECKPOINT_FILE, {
        updatedAt: new Date().toISOString(),
        completedTutorialUrls: [...completed].sort(),
      });

      const done = index + 1;
      if (done === 1 || done % 100 === 0 || done === records.length) {
        console.log(
          '  ' + done + '/' + records.length +
          ' | inserted=' + stats.newMoviesInsertedThisRun +
          ' mapped=' + stats.mappingsAppliedThisRun +
          ' tmdb=' + stats.tmdbDetailNetworkRequests +
          ' cache=' + stats.tmdbDetailCacheHits
        );
      }

      if (!movie?.is_published && normalized && DELAY_MS > 0) await sleep(DELAY_MS);
    } catch (error) {
      stats.errors += 1;
      writeJsonAtomic(SUMMARY_FILE, {
        generatedAt: new Date().toISOString(), ...stats,
        databaseWrites: true,
        completedTutorialUrls: completed.size,
        failedTutorialUrl: record.tutorialUrl,
        lastError: error.message,
        publicationPolicy: 'NEW_MOVIES_UNPUBLISHED',
      });
      throw error;
    }
  }

  writeJsonAtomic(SUMMARY_FILE, {
    generatedAt: new Date().toISOString(), ...stats,
    databaseWrites: true,
    completedTutorialUrls: completed.size,
    finished: completed.size === records.length,
    publicationPolicy: 'NEW_MOVIES_UNPUBLISHED',
  });

  console.log('');
  console.log('[TutorialMovieApplyV2] Complete');
  console.log('  completed tutorials     : ' + completed.size);
  console.log('  new movies inserted     : ' + stats.newMoviesInsertedThisRun);
  console.log('  existing movies reused  : ' + stats.existingMoviesReusedThisRun);
  console.log('  mappings applied        : ' + stats.mappingsAppliedThisRun);
  console.log('  new movies published    : 0');
  console.log('  publication policy      : NEW_MOVIES_UNPUBLISHED');
  console.log('  safe summary            : ' + SUMMARY_FILE);
};

main()
  .catch((error) => {
    console.error('[TutorialMovieApplyV2] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
