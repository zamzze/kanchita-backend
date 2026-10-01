'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter(function (arg) { return !arg.startsWith('--'); });
const pilotArg = args[0];
const extractionArg = args[1];

const TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.TUTORIAL_LISTING_TIMEOUT_MS || '15000', 10));
const DELAY_MS = Math.max(0, Number.parseInt(process.env.TUTORIAL_LISTING_DELAY_MS || '200', 10));
const FIXED_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,' +
  'image/avif,image/webp,image/apng,*/*;q=0.8,' +
  'application/signed-exchange;v=b3;q=0.7';

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const sleep = function (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

const decodeHtmlEntities = function (value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
};

const stripTags = function (value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
};

const normalize = function (value) {
  return stripTags(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

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

const parseAttributes = function (raw) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(raw || ''))) {
    attrs[String(match[1] || '').toLowerCase()] =
      decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
};

const extractYears = function (value) {
  return [...new Set(
    [...String(value || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)]
      .map(function (match) { return Number(match[1]); })
  )];
};

const extractImages = function (html) {
  const images = [];
  const re = /<img\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(html || ''))) {
    const attrs = parseAttributes(match[1]);
    images.push({
      src: attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || null,
      alt: attrs.alt ? stripTags(attrs.alt) : null,
      title: attrs.title ? stripTags(attrs.title) : null
    });
  }
  return images;
};

const requestPage = async function (url) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: FIXED_ACCEPT },
      redirect: 'manual',
      signal: controller.signal
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      bytes: body.length,
      html: body.toString('utf8')
    };
  } finally {
    clearTimeout(timer);
  }
};

const findAnchorContext = function (html, refererUrl, tutorialUrl) {
  const target = normalizeUrlKey(tutorialUrl);
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.href) continue;

    const hrefKey = normalizeUrlKey(attrs.href, refererUrl);
    if (!hrefKey || hrefKey !== target) continue;

    const anchorStart = match.index;
    const anchorEnd = anchorRe.lastIndex;
    const contextHtml = html.slice(
      Math.max(0, anchorStart - 2200),
      Math.min(html.length, anchorEnd + 2200)
    );

    const anchorText = stripTags(match[2]);
    const anchorTitle = attrs.title ? stripTags(attrs.title) : null;
    const anchorImages = extractImages(match[2]);
    const nearbyImages = extractImages(contextHtml).slice(0, 10);
    const nearbyText = stripTags(contextHtml);

    const textCandidates = [
      anchorText,
      anchorTitle
    ]
      .concat(anchorImages.flatMap(function (image) { return [image.alt, image.title]; }))
      .concat(nearbyImages.flatMap(function (image) { return [image.alt, image.title]; }))
      .filter(Boolean);

    return {
      found: true,
      anchorText: anchorText || null,
      anchorTitle: anchorTitle,
      anchorImages: anchorImages,
      nearbyImages: nearbyImages,
      nearbyText: nearbyText || null,
      textCandidates: textCandidates,
      years: extractYears(
        [anchorText, anchorTitle, nearbyText].concat(textCandidates).filter(Boolean).join(' ')
      )
    };
  }

  return {
    found: false,
    anchorText: null,
    anchorTitle: null,
    anchorImages: [],
    nearbyImages: [],
    nearbyText: null,
    textCandidates: [],
    years: []
  };
};

const bestTextCandidate = function (slugTitle, context) {
  const slugNorm = normalize(slugTitle);
  const ranked = [];

  for (const value of context.textCandidates || []) {
    const norm = normalize(value);
    if (!norm) continue;

    let score = 0;
    if (slugNorm && norm === slugNorm) {
      score = 100;
    } else if (slugNorm && (norm.includes(slugNorm) || slugNorm.includes(norm))) {
      score = 80;
    } else if (slugNorm) {
      const slugTokens = new Set(slugNorm.split(' ').filter(Boolean));
      const tokens = new Set(norm.split(' ').filter(Boolean));
      const overlap = [...slugTokens].filter(function (token) { return tokens.has(token); }).length;
      score = slugTokens.size ? Math.round((overlap / slugTokens.size) * 60) : 0;
    }

    ranked.push({ value: value, normalized: norm, score: score });
  }

  ranked.sort(function (a, b) {
    return b.score - a.score || a.normalized.length - b.normalized.length;
  });
  return ranked[0] || null;
};

const main = async function () {
  if (!pilotArg || !extractionArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-listing-context -- ' +
      '<tutorial-tmdb-pilot-private.json> <tutorial-server-extraction-latest.json>'
    );
  }

  const pilotFile = path.resolve(process.cwd(), pilotArg);
  const extractionFile = path.resolve(process.cwd(), extractionArg);

  for (const file of [pilotFile, extractionFile]) {
    if (!fs.existsSync(file)) throw new Error('Input file not found: ' + file);
  }

  const pilot = JSON.parse(fs.readFileSync(pilotFile, 'utf8'));
  const extraction = JSON.parse(fs.readFileSync(extractionFile, 'utf8'));

  const extractionMap = new Map(
    (extraction.records || []).map(function (record) {
      return [normalizeUrlKey(record.tutorialUrl), record];
    })
  );

  const records = (pilot.records || []).map(function (record) {
    const source = extractionMap.get(normalizeUrlKey(record.tutorialUrl)) || null;
    return Object.assign({}, record, { refererUrl: source?.refererUrl || null });
  });

  const byReferer = new Map();
  for (const record of records) {
    if (!record.refererUrl) continue;
    if (!byReferer.has(record.refererUrl)) byReferer.set(record.refererUrl, []);
    byReferer.get(record.refererUrl).push(record);
  }

  const pageCache = new Map();
  const httpStatuses = {};
  let pageRequests = 0;
  let pageErrors = 0;
  let pageIndex = 0;

  console.log('[TutorialListingContextAudit] Starting');
  console.log('  pilot records   : ' + records.length);
  console.log('  unique referers : ' + byReferer.size);
  console.log('  no iframe destinations will be requested');
  console.log('');

  for (const refererUrl of byReferer.keys()) {
    pageIndex += 1;
    try {
      const page = await requestPage(refererUrl);
      pageCache.set(refererUrl, page);
      pageRequests += 1;
      const key = String(page.status);
      httpStatuses[key] = (httpStatuses[key] || 0) + 1;
    } catch (error) {
      pageCache.set(refererUrl, {
        error: error?.name || 'Error',
        status: null,
        html: '',
        bytes: 0,
        contentType: ''
      });
      pageErrors += 1;
    }

    if (pageIndex === 1 || pageIndex % 20 === 0 || pageIndex === byReferer.size) {
      console.log('  pages ' + pageIndex + '/' + byReferer.size);
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const coverage = {
    records: records.length,
    withReferer: 0,
    refererHttp2xx: 0,
    anchorFound: 0,
    anchorText: 0,
    anchorTitle: 0,
    anchorImageAlt: 0,
    nearbyImageAlt: 0,
    yearInContext: 0,
    bestCandidateExactSlug: 0,
    bestCandidateContainsSlug: 0
  };

  const privateRecords = [];

  for (const record of records) {
    if (record.refererUrl) coverage.withReferer += 1;

    const page = record.refererUrl ? pageCache.get(record.refererUrl) : null;
    if (page?.status >= 200 && page.status <= 299) coverage.refererHttp2xx += 1;

    const context = page?.html
      ? findAnchorContext(page.html, record.refererUrl, record.tutorialUrl)
      : {
          found: false,
          textCandidates: [],
          years: [],
          anchorImages: [],
          nearbyImages: []
        };

    if (context.found) coverage.anchorFound += 1;
    if (context.anchorText) coverage.anchorText += 1;
    if (context.anchorTitle) coverage.anchorTitle += 1;
    if ((context.anchorImages || []).some(function (image) { return image.alt; })) {
      coverage.anchorImageAlt += 1;
    }
    if ((context.nearbyImages || []).some(function (image) { return image.alt; })) {
      coverage.nearbyImageAlt += 1;
    }
    if ((context.years || []).length > 0) coverage.yearInContext += 1;

    const best = bestTextCandidate(record?.slug?.titleRaw || '', context);
    if (best?.score === 100) coverage.bestCandidateExactSlug += 1;
    else if (best?.score >= 80) coverage.bestCandidateContainsSlug += 1;

    privateRecords.push({
      tutorialUrl: record.tutorialUrl,
      refererUrl: record.refererUrl,
      slug: record.slug,
      tmdbStatus: record?.tmdbSearch?.status || null,
      tmdbSelected: record?.tmdbSearch?.selected || null,
      listing: {
        httpStatus: page?.status || null,
        pageError: page?.error || null,
        anchorFound: context.found,
        anchorText: context.anchorText,
        anchorTitle: context.anchorTitle,
        anchorImages: context.anchorImages,
        nearbyImages: context.nearbyImages,
        nearbyText: context.nearbyText,
        years: context.years,
        bestTextCandidate: best
      }
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      rawImagesStoredInSummary: false,
      privateDetailFileContainsRealValues: true,
      externalApiRequests: true,
      externalService: 'tutorial listing pages only',
      javascriptExecuted: false,
      iframeDestinationsRequested: false
    },
    population: {
      pilotRecords: records.length,
      uniqueReferers: byReferer.size
    },
    network: {
      pageRequests: pageRequests,
      pageErrors: pageErrors,
      httpStatuses: httpStatuses
    },
    coverage: coverage,
    recommendation: null
  };

  if (coverage.yearInContext >= records.length * 0.5) {
    summary.recommendation = 'LISTING_CONTEXT_YEAR_IS_STRONG_DISAMBIGUATION_SIGNAL';
  } else if (
    coverage.anchorFound >= records.length * 0.8 &&
    (
      coverage.anchorText +
      coverage.anchorTitle +
      coverage.anchorImageAlt +
      coverage.nearbyImageAlt
    ) >= records.length * 0.8
  ) {
    summary.recommendation = 'LISTING_CONTEXT_TEXT_IS_USEFUL_SECONDARY_SIGNAL';
  } else {
    summary.recommendation = 'LISTING_CONTEXT_WEAK_KEEP_SLUG_TMDB_PRIMARY';
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-listing-context-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-listing-context-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log('[TutorialListingContextAudit] Complete');
  console.log('  records                : ' + records.length);
  console.log('  unique referers        : ' + byReferer.size);
  console.log('  page requests          : ' + pageRequests);
  console.log('  page errors            : ' + pageErrors);
  console.log('  anchor found           : ' + coverage.anchorFound);
  console.log('  anchor text            : ' + coverage.anchorText);
  console.log('  anchor title           : ' + coverage.anchorTitle);
  console.log('  anchor image alt       : ' + coverage.anchorImageAlt);
  console.log('  nearby image alt       : ' + coverage.nearbyImageAlt);
  console.log('  year in context        : ' + coverage.yearInContext);
  console.log('  exact slug text signal : ' + coverage.bestCandidateExactSlug);
  console.log('  contains slug signal   : ' + coverage.bestCandidateContainsSlug);
  console.log('  recommendation         : ' + summary.recommendation);
  console.log('  private details        : ' + privateFile);
  console.log('  safe summary           : ' + summaryFile);
};

main().catch(function (error) {
  console.error('[TutorialListingContextAudit] ' + error.message);
  process.exitCode = 1;
});
