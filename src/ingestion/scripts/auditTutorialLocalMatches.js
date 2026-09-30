'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

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

    const yearMatch = rawSlug.match(/(?:^|[-_\s(])(19\d{2}|20\d{2})(?=$|[-_\s)])/);
    const year = yearMatch ? Number(yearMatch[1]) : null;

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

const buildMovieIndex = (movies) => {
  const byTitle = new Map();

  const add = (key, movie, source) => {
    if (!key) return;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push({ movie, source });
  };

  for (const movie of movies) {
    add(normalize(movie.title), movie, 'title');
    add(normalize(movie.original_title), movie, 'original_title');
  }

  return byTitle;
};

const classify = (slug, hits) => {
  if (!slug.normalizedTitle || !hits.length) {
    return { status: 'unmatched', confidence: 0, candidate: null, reasons: [] };
  }

  const uniqueById = new Map();
  for (const hit of hits) {
    const existing = uniqueById.get(hit.movie.id);
    if (!existing) {
      uniqueById.set(hit.movie.id, { ...hit, sources: [hit.source] });
    } else if (!existing.sources.includes(hit.source)) {
      existing.sources.push(hit.source);
    }
  }

  const candidates = [...uniqueById.values()].map((hit) => {
    let score = 70;
    const reasons = ['exact_normalized_title'];

    if (slug.year && hit.movie.release_year) {
      if (Number(hit.movie.release_year) === slug.year) {
        score += 25;
        reasons.push('year_exact');
      } else if (Math.abs(Number(hit.movie.release_year) - slug.year) === 1) {
        score += 5;
        reasons.push('year_near');
      } else {
        score -= 30;
        reasons.push('year_conflict');
      }
    } else if (!slug.year) {
      reasons.push('slug_year_missing');
    }

    if (Number(hit.movie.active_streams || 0) > 0) {
      score += 3;
      reasons.push('has_active_playback');
    }

    if (hit.sources.includes('title') && hit.sources.includes('original_title')) {
      score += 2;
      reasons.push('title_and_original_title');
    }

    return { ...hit, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1] || null;
  const margin = second ? top.score - second.score : top.score;

  if (top.score >= 95 && (!second || margin >= 10)) {
    return {
      status: 'matched_high',
      confidence: top.score,
      candidate: top,
      reasons: top.reasons,
    };
  }

  if (top.score >= 70 && !second) {
    return {
      status: 'matched_unique_title',
      confidence: top.score,
      candidate: top,
      reasons: top.reasons,
    };
  }

  return {
    status: 'ambiguous',
    confidence: top.score,
    candidate: top,
    reasons: top.reasons,
    candidateCount: candidates.length,
  };
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-local-matches -- <tutorial-server-extraction-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

  const extraction = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const tutorials = (extraction.records || []).filter((record) =>
    record.status === 'ok' && record.tutorialUrl
  );

  const { rows: movies } = await pool.query(`
    SELECT
      m.id,
      m.tmdb_id,
      m.title,
      m.original_title,
      m.release_year,
      m.is_published,
      COUNT(s.id) FILTER (WHERE s.is_active = TRUE)::int AS active_streams
    FROM movies m
    LEFT JOIN streams s
      ON s.content_type = 'movie'
     AND s.content_id = m.id
    GROUP BY m.id
  `);

  const index = buildMovieIndex(movies);
  const counts = {};
  const privateRecords = [];
  let withYear = 0;
  let matchedToPlayback = 0;

  for (const tutorial of tutorials) {
    const slug = parseSlug(tutorial.tutorialUrl);
    if (slug.year) withYear += 1;

    const hits = index.get(slug.normalizedTitle) || [];
    const result = classify(slug, hits);
    counts[result.status] = (counts[result.status] || 0) + 1;

    if (Number(result.candidate?.movie?.active_streams || 0) > 0) {
      matchedToPlayback += 1;
    }

    privateRecords.push({
      tutorialUrl: tutorial.tutorialUrl,
      slug,
      result: {
        status: result.status,
        confidence: result.confidence,
        reasons: result.reasons,
        candidateCount: result.candidateCount || (result.candidate ? 1 : 0),
        localMovie: result.candidate ? {
          id: result.candidate.movie.id,
          tmdbId: result.candidate.movie.tmdb_id,
          title: result.candidate.movie.title,
          originalTitle: result.candidate.movie.original_title,
          releaseYear: result.candidate.movie.release_year,
          activeStreams: result.candidate.movie.active_streams,
        } : null,
      },
    });
  }

  const resolved = counts.matched_high || 0;
  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      privateDetailFileContainsRealValues: true,
      externalApiRequests: false,
    },
    population: {
      tutorialsOk: tutorials.length,
      localMovies: movies.length,
      localMoviesWithActivePlayback: movies.filter((m) => Number(m.active_streams || 0) > 0).length,
      tutorialsWithYearInSlug: withYear,
    },
    matchCounts: counts,
    resolvedLocally: resolved,
    unresolvedForTmdb: tutorials.length - resolved,
    matchedCandidateHasActivePlayback: matchedToPlayback,
    nextStep: 'TMDB_VERIFY_UNIQUE_TITLE_AND_MATCH_UNRESOLVED',
  };

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-local-matches-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-local-matches-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialLocalMatchAudit] Complete');
  console.log(`  tutorials OK              : ${tutorials.length}`);
  console.log(`  local movies              : ${movies.length}`);
  console.log(`  local movies w/playback   : ${summary.population.localMoviesWithActivePlayback}`);
  console.log(`  slug with year            : ${withYear}`);
  console.log(`  matched high              : ${counts.matched_high || 0}`);
  console.log(`  matched unique title      : ${counts.matched_unique_title || 0}`);
  console.log(`  ambiguous                 : ${counts.ambiguous || 0}`);
  console.log(`  unmatched                 : ${counts.unmatched || 0}`);
  console.log(`  resolved locally          : ${resolved}`);
  console.log(`  unresolved for TMDB       : ${summary.unresolvedForTmdb}`);
  console.log(`  private details           : ${privateFile}`);
  console.log(`  safe summary              : ${summaryFile}`);
};

main()
  .catch((error) => {
    console.error(`[TutorialLocalMatchAudit] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
