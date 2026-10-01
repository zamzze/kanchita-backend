'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter(function (arg) { return !arg.startsWith('--'); });
const pilotArg = args[0];
const harvestArg = args[1];
const extractionArg = args[2];

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');

const normalizeUrlKey = function (raw, base) {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
};

const typeOf = function (value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const scalarPreview = function (value) {
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      looksLikeUrl: /^https?:\/\//i.test(value),
      looksLikeHtml: /<[^>]+>/.test(value),
      hasYear: /\b(19\d{2}|20\d{2})\b/.test(value)
    };
  }

  if (typeof value === 'number') {
    return {
      type: 'number',
      integer: Number.isInteger(value),
      plausibleYear: value >= 1900 && value <= 2100
    };
  }

  return { type: typeOf(value) };
};

const signatureOfObject = function (object) {
  const entries = Object.entries(object || {})
    .map(function ([key, value]) {
      return key + ':' + typeOf(value);
    })
    .sort();

  return entries.join('|');
};

const addCount = function (map, key) {
  map.set(key, (map.get(key) || 0) + 1);
};

const findHits = function (value, tutorialUrl, baseUrl, pathParts, parent, grandParent, output, seen, depth) {
  if (value === null || value === undefined || depth > 16) return;

  if (typeof value === 'string') {
    const target = normalizeUrlKey(tutorialUrl);
    const direct = normalizeUrlKey(value, baseUrl);

    let slug = '';
    try {
      slug = decodeURIComponent(
        new URL(tutorialUrl).pathname.split('/').filter(Boolean).pop() || ''
      );
    } catch {}

    const exactUrlValue = Boolean(target && direct && target === direct);
    const containsTutorialUrl = value.includes(tutorialUrl);
    const containsSlug = Boolean(slug && value.includes(slug));

    if (!exactUrlValue && !containsTutorialUrl && !containsSlug) return;

    output.push({
      jsonPath: pathParts.join('.'),
      exactUrlValue,
      containsTutorialUrl,
      containsSlug,
      valueProfile: scalarPreview(value),
      parentType: typeOf(parent),
      parentSignature: parent && !Array.isArray(parent) && typeof parent === 'object'
        ? signatureOfObject(parent)
        : null,
      parentKeys: parent && !Array.isArray(parent) && typeof parent === 'object'
        ? Object.keys(parent).sort()
        : [],
      parentSiblingProfiles: parent && !Array.isArray(parent) && typeof parent === 'object'
        ? Object.fromEntries(
            Object.entries(parent).map(function ([key, sibling]) {
              return [key, scalarPreview(sibling)];
            })
          )
        : null,
      grandParentType: typeOf(grandParent),
      grandParentSignature:
        grandParent && !Array.isArray(grandParent) && typeof grandParent === 'object'
          ? signatureOfObject(grandParent)
          : null,
      grandParentKeys:
        grandParent && !Array.isArray(grandParent) && typeof grandParent === 'object'
          ? Object.keys(grandParent).sort()
          : [],
      arrayIndex:
        Array.isArray(parent)
          ? Number(String(pathParts[pathParts.length - 1] || '').replace(/\D/g, '')) || 0
          : null
    });

    return;
  }

  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      findHits(
        value[i],
        tutorialUrl,
        baseUrl,
        pathParts.concat('[' + i + ']'),
        value,
        parent,
        output,
        seen,
        depth + 1
      );
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    findHits(
      child,
      tutorialUrl,
      baseUrl,
      pathParts.concat(key),
      value,
      parent,
      output,
      seen,
      depth + 1
    );
  }
};

const main = function () {
  if (!pilotArg || !harvestArg || !extractionArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-harvest-shape -- ' +
      '<tutorial-tmdb-pilot-private.json> <catalog-harvest.json> ' +
      '<tutorial-server-extraction-latest.json>'
    );
  }

  const pilotFile = path.resolve(process.cwd(), pilotArg);
  const harvestFile = path.resolve(process.cwd(), harvestArg);
  const extractionFile = path.resolve(process.cwd(), extractionArg);

  for (const file of [pilotFile, harvestFile, extractionFile]) {
    if (!fs.existsSync(file)) throw new Error('Input file not found: ' + file);
  }

  const pilot = JSON.parse(fs.readFileSync(pilotFile, 'utf8'));
  const harvest = JSON.parse(fs.readFileSync(harvestFile, 'utf8'));
  const extraction = JSON.parse(fs.readFileSync(extractionFile, 'utf8'));

  const extractionMap = new Map(
    (extraction.records || []).map(function (record) {
      return [normalizeUrlKey(record.tutorialUrl), record];
    })
  );

  const pagesByUrl = new Map();
  for (const page of harvest.pages || []) {
    const key = normalizeUrlKey(page?.pageUrl);
    if (key) pagesByUrl.set(key, page);
  }

  const pathCounts = new Map();
  const parentSignatureCounts = new Map();
  const grandParentSignatureCounts = new Map();
  const parentKeyCounts = new Map();
  const hitModeCounts = new Map();

  const privateRecords = [];

  let records = 0;
  let recordsWithPage = 0;
  let recordsWithHit = 0;
  let exactValueHits = 0;
  let containedHits = 0;

  for (const pilotRecord of pilot.records || []) {
    records += 1;

    const source = extractionMap.get(normalizeUrlKey(pilotRecord.tutorialUrl)) || null;
    const refererUrl = source?.refererUrl || null;
    const page = refererUrl
      ? pagesByUrl.get(normalizeUrlKey(refererUrl)) || null
      : null;

    if (page) recordsWithPage += 1;

    const hits = [];
    if (page) {
      findHits(
        page,
        pilotRecord.tutorialUrl,
        refererUrl,
        ['page'],
        null,
        null,
        hits,
        new WeakSet(),
        0
      );
    }

    if (hits.length > 0) recordsWithHit += 1;

    for (const hit of hits) {
      addCount(pathCounts, hit.jsonPath);
      if (hit.parentSignature) addCount(parentSignatureCounts, hit.parentSignature);
      if (hit.grandParentSignature) addCount(grandParentSignatureCounts, hit.grandParentSignature);

      for (const key of hit.parentKeys || []) addCount(parentKeyCounts, key);

      const mode = hit.exactUrlValue
        ? 'exact_url_value'
        : hit.containsTutorialUrl
          ? 'contains_full_url'
          : 'contains_slug';

      addCount(hitModeCounts, mode);

      if (hit.exactUrlValue) exactValueHits += 1;
      else containedHits += 1;
    }

    privateRecords.push({
      tutorialUrl: pilotRecord.tutorialUrl,
      refererUrl,
      tmdbStatus: pilotRecord?.tmdbSearch?.status || null,
      hitCount: hits.length,
      hits
    });
  }

  const top = function (map, limit) {
    return [...map.entries()]
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, limit)
      .map(function ([key, count]) { return { key, count }; });
  };

  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      privateDetailFileContainsRealValues: true,
      networkRequests: 0
    },
    population: {
      pilotRecords: records,
      harvestPages: (harvest.pages || []).length
    },
    coverage: {
      recordsWithRefererPage: recordsWithPage,
      recordsWithAtLeastOneHit: recordsWithHit,
      exactUrlValueHits: exactValueHits,
      containedHits
    },
    shapes: {
      hitModes: top(hitModeCounts, 10),
      topJsonPaths: top(pathCounts, 20),
      topParentSignatures: top(parentSignatureCounts, 20),
      topGrandParentSignatures: top(grandParentSignatureCounts, 20),
      topParentKeys: top(parentKeyCounts, 30)
    },
    recommendation: null
  };

  if (
    summary.shapes.topParentSignatures[0] &&
    summary.shapes.topParentSignatures[0].count >= records * 0.7
  ) {
    summary.recommendation = 'DOMINANT_PARENT_SHAPE_FOUND_BUILD_CUSTOM_PARSER';
  } else if (
    summary.shapes.topJsonPaths[0] &&
    summary.shapes.topJsonPaths[0].count >= records * 0.7
  ) {
    summary.recommendation = 'DOMINANT_JSON_PATH_FOUND_BUILD_CUSTOM_PARSER';
  } else {
    summary.recommendation = 'MULTIPLE_HARVEST_SHAPES_NEED_MULTI_PATTERN_PARSER';
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-harvest-shape-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-harvest-shape-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialHarvestShapeAudit] Complete');
  console.log('  pilot records          : ' + records);
  console.log('  referer pages found    : ' + recordsWithPage);
  console.log('  records with hits      : ' + recordsWithHit);
  console.log('  exact URL value hits   : ' + exactValueHits);
  console.log('  contained hits         : ' + containedHits);
  console.log('  top parent signature   : ' +
    (summary.shapes.topParentSignatures[0]?.key || 'none'));
  console.log('  top parent count       : ' +
    (summary.shapes.topParentSignatures[0]?.count || 0));
  console.log('  top JSON path          : ' +
    (summary.shapes.topJsonPaths[0]?.key || 'none'));
  console.log('  top JSON path count    : ' +
    (summary.shapes.topJsonPaths[0]?.count || 0));
  console.log('  recommendation         : ' + summary.recommendation);
  console.log('  private details        : ' + privateFile);
  console.log('  safe summary           : ' + summaryFile);
};

try {
  main();
} catch (error) {
  console.error('[TutorialHarvestShapeAudit] ' + error.message);
  process.exitCode = 1;
}
