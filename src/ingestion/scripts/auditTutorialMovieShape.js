'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const extractionArg = args[0];
const harvestArg = args[1];
const triageArg = args[2];

const PRIVATE_OUT = path.resolve(process.cwd(), 'data-private');
const REPORT_OUT = path.resolve(process.cwd(), 'reports');

const normalizeUrlKey = (raw, base) => {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const scalar = (value) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const FIELD_PATTERNS = {
  title: /^(title|name|label|text|movie_title|video_title|tutorial_title)$/i,
  year: /^(year|release_year|releaseyear|release_date|releasedate|date)$/i,
  tmdbId: /^(tmdb|tmdb_id|tmdbid)$/i,
  imdbId: /^(imdb|imdb_id|imdbid)$/i,
  slug: /^(slug)$/i,
  image: /^(image|image_url|poster|poster_url|thumbnail|thumbnail_url|thumb)$/i,
  mediaType: /^(type|media_type|mediatype|content_type|category)$/i,
};

const classifyKey = (key) => {
  for (const [kind, pattern] of Object.entries(FIELD_PATTERNS)) {
    if (pattern.test(key)) return kind;
  }
  return null;
};

const normalizeYear = (value) => {
  const match = String(value ?? '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
};

const normalizeExternalId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return text || null;
};

const deriveSlugTitle = (urlValue) => {
  try {
    const url = new URL(urlValue);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const slug = decodeURIComponent(parts[parts.length - 1]);
    const cleaned = slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b(?:tutorial|video|ver|watch)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.length >= 2 ? cleaned : null;
  } catch {
    return null;
  }
};

const extractSiblingMetadata = (object) => {
  const metadata = {};
  const observedKeys = [];

  for (const [key, value] of Object.entries(object || {})) {
    observedKeys.push(key);
    if (!scalar(value)) continue;
    const kind = classifyKey(key);
    if (!kind || metadata[kind] !== undefined) continue;
    metadata[kind] = value;
  }

  return { metadata, observedKeys };
};

const buildCatalogIndex = (harvest, primarySet) => {
  const index = new Map();
  const keyFrequency = new Map();
  let matchedObjectCount = 0;

  const addHit = (tutorialKey, hit) => {
    if (!index.has(tutorialKey)) index.set(tutorialKey, []);
    index.get(tutorialKey).push(hit);
  };

  const visit = (value, baseUrl, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined || depth > 10) return;
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) visit(child, baseUrl, depth + 1, seen);
      return;
    }

    const directTutorials = [];
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== 'string') continue;
      const normalized = normalizeUrlKey(child, baseUrl);
      if (normalized && primarySet.has(normalized)) {
        directTutorials.push({ normalized, urlField: key });
      }
    }

    if (directTutorials.length) {
      matchedObjectCount += 1;
      const { metadata, observedKeys } = extractSiblingMetadata(value);
      for (const key of observedKeys) {
        keyFrequency.set(key, (keyFrequency.get(key) || 0) + 1);
      }
      for (const tutorial of directTutorials) {
        addHit(tutorial.normalized, {
          urlField: tutorial.urlField,
          metadata,
          observedKeys,
        });
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') visit(child, baseUrl, depth + 1, seen);
    }
  };

  for (const page of harvest.pages || []) {
    visit(page, page?.pageUrl || undefined);
  }

  return { index, keyFrequency, matchedObjectCount };
};

const chooseCandidate = (tutorialUrl, hits) => {
  const candidates = hits || [];
  const pick = (kind) => {
    for (const hit of candidates) {
      const value = hit?.metadata?.[kind];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return null;
  };

  const rawTitle = pick('title');
  const slugTitle = deriveSlugTitle(tutorialUrl);
  const title = rawTitle ? String(rawTitle).trim() : slugTitle;
  const titleSource = rawTitle ? 'catalog' : (slugTitle ? 'url_slug' : null);

  return {
    title,
    titleSource,
    year: normalizeYear(pick('year')),
    tmdbId: normalizeExternalId(pick('tmdbId')),
    imdbId: normalizeExternalId(pick('imdbId')),
    mediaType: normalizeExternalId(pick('mediaType')),
    image: normalizeExternalId(pick('image')),
    catalogHitCount: candidates.length,
    observedCatalogKeys: [...new Set(candidates.flatMap((hit) => hit.observedKeys || []))].sort(),
  };
};

const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

const main = () => {
  if (!extractionArg || !harvestArg || !triageArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-movies -- <extraction-latest.json> <catalog-harvest.json> <catalog-triage.json>'
    );
  }

  const extractionFile = path.resolve(process.cwd(), extractionArg);
  const harvestFile = path.resolve(process.cwd(), harvestArg);
  const triageFile = path.resolve(process.cwd(), triageArg);
  for (const file of [extractionFile, harvestFile, triageFile]) {
    if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
  }

  const extraction = readJson(extractionFile);
  const harvest = readJson(harvestFile);
  const triage = readJson(triageFile);

  const primaryUrls = [...new Set(
    (triage.records || [])
      .filter((record) => record.classification === 'primary')
      .map((record) => normalizeUrlKey(record.url))
      .filter(Boolean)
  )];
  const primarySet = new Set(primaryUrls);
  const extractionByUrl = new Map(
    (extraction.records || [])
      .map((record) => [normalizeUrlKey(record.tutorialUrl), record])
      .filter(([key]) => key)
  );

  const { index, keyFrequency, matchedObjectCount } = buildCatalogIndex(harvest, primarySet);

  const coverage = {
    totalPrimary: primaryUrls.length,
    extractionPresent: 0,
    catalogObjectMatched: 0,
    title: 0,
    titleFromCatalog: 0,
    titleFromSlug: 0,
    year: 0,
    tmdbId: 0,
    imdbId: 0,
    mediaType: 0,
    image: 0,
    withServers: 0,
    noServers: 0,
    notFound404: 0,
  };

  const privateRecords = [];
  const titleYearGroups = new Map();
  const statuses = {};

  for (const tutorialUrl of primaryUrls) {
    const extractionRecord = extractionByUrl.get(tutorialUrl) || null;
    const hits = index.get(tutorialUrl) || [];
    const movie = chooseCandidate(tutorialUrl, hits);

    if (extractionRecord) coverage.extractionPresent += 1;
    if (hits.length) coverage.catalogObjectMatched += 1;
    if (movie.title) coverage.title += 1;
    if (movie.titleSource === 'catalog') coverage.titleFromCatalog += 1;
    if (movie.titleSource === 'url_slug') coverage.titleFromSlug += 1;
    if (movie.year) coverage.year += 1;
    if (movie.tmdbId) coverage.tmdbId += 1;
    if (movie.imdbId) coverage.imdbId += 1;
    if (movie.mediaType) coverage.mediaType += 1;
    if (movie.image) coverage.image += 1;

    const status = extractionRecord?.status || 'missing_extraction';
    inc(statuses, status);
    if ((extractionRecord?.validServerCount || 0) > 0) coverage.withServers += 1;
    if (status === 'no_servers') coverage.noServers += 1;
    if (status === 'not_found_404') coverage.notFound404 += 1;

    if (movie.title) {
      const groupKey = `${movie.title.toLowerCase()}|${movie.year || ''}`;
      titleYearGroups.set(groupKey, (titleYearGroups.get(groupKey) || 0) + 1);
    }

    privateRecords.push({
      tutorialUrl: extractionRecord?.tutorialUrl || tutorialUrl,
      refererUrl: extractionRecord?.refererUrl || null,
      fetchStatus: status,
      serverCount: extractionRecord?.validServerCount || 0,
      servers: (extractionRecord?.servers || [])
        .filter((server) => server?.valid && server?.iframeUrl)
        .map((server) => ({
          ordinal: server.ordinal,
          iframeUrl: server.iframeUrl,
          host: server.host || null,
        })),
      movieCandidate: movie,
    });
  }

  const duplicateGroups = [...titleYearGroups.values()].filter((count) => count > 1);
  const topObservedKeys = [...keyFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([key, count]) => ({ key, count }));

  const summary = {
    generatedAt: new Date().toISOString(),
    confidentialValuesPersistedInSummary: false,
    inputs: {
      extractionRecords: extraction.records?.length || 0,
      harvestPages: harvest.pages?.length || 0,
      triageRecords: triage.records?.length || 0,
    },
    coverage,
    extractionStatuses: statuses,
    catalogStructure: {
      matchedObjectCount,
      tutorialsWithDirectCatalogObject: index.size,
      topObservedSiblingKeys: topObservedKeys,
    },
    grouping: {
      uniqueTitleYearKeys: titleYearGroups.size,
      duplicateTitleYearGroups: duplicateGroups.length,
      tutorialsInsideDuplicateGroups: duplicateGroups.reduce((sum, count) => sum + count, 0),
    },
    recommendation: null,
  };

  if (coverage.tmdbId >= coverage.totalPrimary * 0.9) {
    summary.recommendation = 'DIRECT_TMDB_ID_MATCHING_AVAILABLE';
  } else if (coverage.title >= coverage.totalPrimary * 0.95 && coverage.year >= coverage.totalPrimary * 0.7) {
    summary.recommendation = 'TITLE_YEAR_TMDB_MATCHING_IS_VIABLE';
  } else if (coverage.title >= coverage.totalPrimary * 0.95) {
    summary.recommendation = 'TITLE_MATCHING_VIABLE_YEAR_ENRICHMENT_NEEDED';
  } else {
    summary.recommendation = 'CATALOG_METADATA_ENRICHMENT_REQUIRED';
  }

  fs.mkdirSync(PRIVATE_OUT, { recursive: true });
  fs.mkdirSync(REPORT_OUT, { recursive: true });

  const privateFile = path.join(PRIVATE_OUT, 'tutorial-movie-candidates.json');
  const summaryFile = path.join(REPORT_OUT, 'tutorial-movie-shape-summary.json');

  fs.writeFileSync(privateFile, JSON.stringify({
    generatedAt: summary.generatedAt,
    records: privateRecords,
  }, null, 2), 'utf8');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialMovieAudit] Complete');
  console.log(`  primary                 : ${coverage.totalPrimary}`);
  console.log(`  extraction present      : ${coverage.extractionPresent}`);
  console.log(`  catalog object matched  : ${coverage.catalogObjectMatched}`);
  console.log(`  title                   : ${coverage.title}`);
  console.log(`    from catalog          : ${coverage.titleFromCatalog}`);
  console.log(`    from URL slug         : ${coverage.titleFromSlug}`);
  console.log(`  year                    : ${coverage.year}`);
  console.log(`  tmdb id                 : ${coverage.tmdbId}`);
  console.log(`  imdb id                 : ${coverage.imdbId}`);
  console.log(`  image                   : ${coverage.image}`);
  console.log(`  with servers            : ${coverage.withServers}`);
  console.log(`  duplicate title/year groups: ${summary.grouping.duplicateTitleYearGroups}`);
  console.log(`  recommendation          : ${summary.recommendation}`);
  console.log(`  private candidates      : ${privateFile}`);
  console.log(`  sanitized summary       : ${summaryFile}`);
};

try {
  main();
} catch (error) {
  console.error(`[TutorialMovieAudit] ${error.message}`);
  process.exitCode = 1;
}
