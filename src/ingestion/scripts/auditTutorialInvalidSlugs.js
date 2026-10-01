'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const bucketLength = (n) => {
  if (n === 0) return '0';
  if (n <= 2) return '1-2';
  if (n <= 5) return '3-5';
  if (n <= 10) return '6-10';
  if (n <= 30) return '11-30';
  return '31+';
};

const inc = (obj, key) => {
  obj[key] = (obj[key] || 0) + 1;
};

const main = () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-invalid-slugs -- ' +
      '<tutorial-movie-matcher-v1-latest.json>'
    );
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error('Input file not found: ' + inputFile);
  }

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const invalid = (input.records || []).filter(
    (record) => record?.match?.method === 'invalid_slug'
  );

  const reasons = {};
  const pathSegmentCounts = {};
  const lastSegmentLengthBuckets = {};
  const queryKeyCounts = {};
  const pathShapes = {};
  let absoluteUrl = 0;
  let relativeOrInvalidUrl = 0;
  let hasQuery = 0;
  let hasHash = 0;

  for (const record of invalid) {
    const raw = String(record.tutorialUrl || '');

    try {
      const url = new URL(raw);
      absoluteUrl += 1;

      const segments = url.pathname.split('/').filter(Boolean);
      inc(pathSegmentCounts, String(segments.length));

      if (url.search) {
        hasQuery += 1;
        for (const key of url.searchParams.keys()) {
          inc(queryKeyCounts, key);
        }
      }

      if (url.hash) hasHash += 1;

      const last = decodeURIComponent(segments[segments.length - 1] || '');
      inc(lastSegmentLengthBuckets, bucketLength(last.length));

      let reason;
      if (!segments.length) {
        reason = 'no_path_segments';
      } else if (!last.trim()) {
        reason = 'empty_last_segment';
      } else if (/^\d+$/.test(last)) {
        reason = 'numeric_last_segment';
      } else if (/^(?:19|20)\d{2}$/.test(last)) {
        reason = 'year_only_last_segment';
      } else if (!/[A-Za-z0-9À-ÿ]/.test(last)) {
        reason = 'punctuation_only_last_segment';
      } else {
        reason = 'parser_or_normalization_mismatch';
      }
      inc(reasons, reason);

      const shape = '/' + segments.map((segment) => {
        if (/^\d+$/.test(segment)) return ':num';
        if (/^(?:19|20)\d{2}$/.test(segment)) return ':year';
        if (segment.length <= 2) return ':short';
        return ':text';
      }).join('/');

      inc(pathShapes, shape || '/');
    } catch {
      relativeOrInvalidUrl += 1;
      inc(reasons, 'url_parse_failed');
    }
  }

  const top = (object, limit = 20) =>
    Object.entries(object)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));

  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawUrlsStored: false,
      rawSlugsStored: false,
      rawTitlesStored: false,
      networkRequests: 0,
      databaseQueries: 0,
    },
    population: {
      totalRecords: (input.records || []).length,
      invalidSlugRecords: invalid.length,
    },
    urlProfile: {
      absoluteUrl,
      relativeOrInvalidUrl,
      hasQuery,
      hasHash,
      pathSegmentCounts: top(pathSegmentCounts),
      lastSegmentLengthBuckets: top(lastSegmentLengthBuckets),
      queryKeyCounts: top(queryKeyCounts),
      pathShapes: top(pathShapes),
    },
    invalidReasons: top(reasons),
    recommendation: null,
  };

  const topReason = summary.invalidReasons[0]?.key || null;
  if (topReason === 'url_parse_failed') {
    summary.recommendation = 'ADD_RELATIVE_URL_AND_BASE_URL_FALLBACK';
  } else if (
    topReason === 'numeric_last_segment' ||
    topReason === 'year_only_last_segment'
  ) {
    summary.recommendation = 'TITLE_IS_NOT_IN_LAST_PATH_SEGMENT';
  } else if (hasQuery >= invalid.length * 0.5) {
    summary.recommendation = 'INSPECT_QUERY_PARAMETER_TITLE_SOURCE';
  } else {
    summary.recommendation = 'INSPECT_MATCHER_PARSESLUG_IMPLEMENTATION';
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-invalid-slugs-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialInvalidSlugAudit] Complete');
  console.log('  total records       : ' + summary.population.totalRecords);
  console.log('  invalid slug        : ' + summary.population.invalidSlugRecords);
  console.log('  absolute URL        : ' + absoluteUrl);
  console.log('  parse failed        : ' + relativeOrInvalidUrl);
  console.log('  has query           : ' + hasQuery);
  console.log('  top reason          : ' + (topReason || 'none'));
  console.log('  recommendation      : ' + summary.recommendation);
  console.log('  safe summary        : ' + output);
};

try {
  main();
} catch (error) {
  console.error('[TutorialInvalidSlugAudit] ' + error.message);
  process.exitCode = 1;
}
