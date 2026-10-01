'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter(function (arg) { return !arg.startsWith('--'); });
const pilotArg = args[0];
const harvestArg = args[1];
const extractionArg = args[2];

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

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

const extractYears = function (value) {
  return [...new Set(
    [...String(value || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)]
      .map(function (match) { return Number(match[1]); })
  )];
};

const findAnchorInHtml = function (html, baseUrl, tutorialUrl) {
  const target = normalizeUrlKey(tutorialUrl);
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.href) continue;

    const hrefKey = normalizeUrlKey(attrs.href, baseUrl);
    if (!hrefKey || hrefKey !== target) continue;

    const contextHtml = html.slice(
      Math.max(0, match.index - 1800),
      Math.min(html.length, anchorRe.lastIndex + 1800)
    );

    const anchorText = stripTags(match[2]);
    const anchorTitle = attrs.title ? stripTags(attrs.title) : null;
    const anchorImages = extractImages(match[2]);
    const nearbyImages = extractImages(contextHtml).slice(0, 10);
    const nearbyText = stripTags(contextHtml);

    return {
      matchedAsHtmlAnchor: true,
      anchorText: anchorText || null,
      anchorTitle,
      anchorImages,
      nearbyImages,
      nearbyText: nearbyText || null,
      years: extractYears([anchorText, anchorTitle, nearbyText].filter(Boolean).join(' '))
    };
  }

  return null;
};

const collectStringHits = function (value, tutorialUrl, baseUrl, output, pathParts, depth, seen) {
  if (value === null || value === undefined || depth > 14) return;

  if (typeof value === 'string') {
    const raw = value;
    const tutorialKey = normalizeUrlKey(tutorialUrl);
    let slug = '';

    try {
      slug = decodeURIComponent(
        new URL(tutorialUrl).pathname.split('/').filter(Boolean).pop() || ''
      );
    } catch {}

    const containsAbsolute = raw.includes(tutorialUrl);
    const containsNormalized =
      tutorialKey && raw.includes(tutorialKey);
    const containsSlug = slug && raw.includes(slug);

    if (!containsAbsolute && !containsNormalized && !containsSlug) return;

    const anchor = /<a\b/i.test(raw)
      ? findAnchorInHtml(raw, baseUrl, tutorialUrl)
      : null;

    let needleIndex = containsAbsolute
      ? raw.indexOf(tutorialUrl)
      : containsNormalized
        ? raw.indexOf(tutorialKey)
        : raw.indexOf(slug);

    if (needleIndex < 0) needleIndex = 0;

    const snippet = raw.slice(
      Math.max(0, needleIndex - 1800),
      Math.min(raw.length, needleIndex + 1800)
    );

    output.push({
      jsonPath: pathParts.join('.'),
      stringLength: raw.length,
      htmlLike: /<[^>]+>/.test(raw),
      containsAbsolute,
      containsNormalized,
      containsSlug,
      anchor,
      snippetText: stripTags(snippet),
      years: extractYears(snippet)
    });

    return;
  }

  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectStringHits(
        value[i],
        tutorialUrl,
        baseUrl,
        output,
        pathParts.concat('[' + i + ']'),
        depth + 1,
        seen
      );
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    collectStringHits(
      child,
      tutorialUrl,
      baseUrl,
      output,
      pathParts.concat(key),
      depth + 1,
      seen
    );
  }
};

const bestCandidate = function (slugTitle, hits) {
  const slugNorm = normalize(slugTitle);
  const candidates = [];

  for (const hit of hits) {
    if (hit.anchor) {
      const values = [
        hit.anchor.anchorText,
        hit.anchor.anchorTitle,
        ...(hit.anchor.anchorImages || []).flatMap(function (image) {
          return [image.alt, image.title];
        }),
        ...(hit.anchor.nearbyImages || []).flatMap(function (image) {
          return [image.alt, image.title];
        })
      ].filter(Boolean);

      for (const value of values) {
        const norm = normalize(value);
        if (!norm) continue;

        let score = 0;
        if (slugNorm && norm === slugNorm) score = 100;
        else if (slugNorm && (norm.includes(slugNorm) || slugNorm.includes(norm))) score = 80;
        else if (slugNorm) {
          const a = new Set(slugNorm.split(' ').filter(Boolean));
          const b = new Set(norm.split(' ').filter(Boolean));
          const overlap = [...a].filter(function (token) { return b.has(token); }).length;
          score = a.size ? Math.round((overlap / a.size) * 60) : 0;
        }

        candidates.push({
          source: 'html_anchor',
          value,
          normalized: norm,
          score,
          years: hit.anchor.years || []
        });
      }
    }

    if (hit.snippetText) {
      const norm = normalize(hit.snippetText);
      if (norm) {
        let score = 0;
        if (slugNorm && norm.includes(slugNorm)) score = 70;
        candidates.push({
          source: 'harvest_snippet',
          value: hit.snippetText,
          normalized: norm,
          score,
          years: hit.years || []
        });
      }
    }
  }

  candidates.sort(function (a, b) {
    return b.score - a.score || a.normalized.length - b.normalized.length;
  });

  return candidates[0] || null;
};

const main = function () {
  if (!pilotArg || !harvestArg || !extractionArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-harvest-context -- ' +
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

  const coverage = {
    records: 0,
    withReferer: 0,
    refererPageFoundInHarvest: 0,
    stringHit: 0,
    htmlAnchorFound: 0,
    anchorText: 0,
    anchorTitle: 0,
    anchorImageAlt: 0,
    nearbyImageAlt: 0,
    yearInHarvestContext: 0,
    bestExactSlug: 0,
    bestContainsSlug: 0
  };

  const privateRecords = [];

  for (const pilotRecord of pilot.records || []) {
    coverage.records += 1;

    const source = extractionMap.get(normalizeUrlKey(pilotRecord.tutorialUrl)) || null;
    const refererUrl = source?.refererUrl || null;
    if (refererUrl) coverage.withReferer += 1;

    const page = refererUrl
      ? pagesByUrl.get(normalizeUrlKey(refererUrl)) || null
      : null;

    if (page) coverage.refererPageFoundInHarvest += 1;

    const hits = [];
    if (page) {
      collectStringHits(
        page,
        pilotRecord.tutorialUrl,
        refererUrl,
        hits,
        ['page'],
        0,
        new WeakSet()
      );
    }

    if (hits.length > 0) coverage.stringHit += 1;

    const anchors = hits.map(function (hit) { return hit.anchor; }).filter(Boolean);
    if (anchors.length > 0) coverage.htmlAnchorFound += 1;
    if (anchors.some(function (anchor) { return anchor.anchorText; })) coverage.anchorText += 1;
    if (anchors.some(function (anchor) { return anchor.anchorTitle; })) coverage.anchorTitle += 1;
    if (anchors.some(function (anchor) {
      return (anchor.anchorImages || []).some(function (image) { return image.alt; });
    })) coverage.anchorImageAlt += 1;
    if (anchors.some(function (anchor) {
      return (anchor.nearbyImages || []).some(function (image) { return image.alt; });
    })) coverage.nearbyImageAlt += 1;

    const years = [...new Set(
      hits.flatMap(function (hit) {
        return (hit.years || []).concat(hit.anchor?.years || []);
      })
    )];

    if (years.length > 0) coverage.yearInHarvestContext += 1;

    const best = bestCandidate(pilotRecord?.slug?.titleRaw || '', hits);
    if (best?.score === 100) coverage.bestExactSlug += 1;
    else if (best?.score >= 80) coverage.bestContainsSlug += 1;

    privateRecords.push({
      tutorialUrl: pilotRecord.tutorialUrl,
      refererUrl,
      tmdbStatus: pilotRecord?.tmdbSearch?.status || null,
      slug: pilotRecord.slug,
      harvest: {
        pageFound: Boolean(page),
        hitCount: hits.length,
        years,
        bestCandidate: best,
        hits
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
      networkRequests: 0,
      javascriptExecuted: false,
      iframeDestinationsRequested: false
    },
    population: {
      pilotRecords: coverage.records,
      harvestPages: (harvest.pages || []).length
    },
    coverage,
    recommendation: null
  };

  if (coverage.yearInHarvestContext >= coverage.records * 0.5) {
    summary.recommendation = 'HARVEST_CONTEXT_YEAR_IS_STRONG_SIGNAL';
  } else if (
    coverage.htmlAnchorFound >= coverage.records * 0.7 &&
    (coverage.anchorText + coverage.anchorImageAlt + coverage.nearbyImageAlt) >= coverage.records * 0.7
  ) {
    summary.recommendation = 'HARVEST_CONTEXT_TEXT_IS_USEFUL_SIGNAL';
  } else if (coverage.stringHit >= coverage.records * 0.7) {
    summary.recommendation = 'HARVEST_CONTEXT_EXISTS_BUT_NEEDS_CUSTOM_PARSER';
  } else {
    summary.recommendation = 'HARVEST_CONTEXT_WEAK_KEEP_SLUG_TMDB_PRIMARY';
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-harvest-context-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-harvest-context-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialHarvestContextAudit] Complete');
  console.log('  records                    : ' + coverage.records);
  console.log('  referer pages in harvest   : ' + coverage.refererPageFoundInHarvest);
  console.log('  string hits                : ' + coverage.stringHit);
  console.log('  HTML anchors               : ' + coverage.htmlAnchorFound);
  console.log('  anchor text                : ' + coverage.anchorText);
  console.log('  anchor title               : ' + coverage.anchorTitle);
  console.log('  anchor image alt           : ' + coverage.anchorImageAlt);
  console.log('  nearby image alt           : ' + coverage.nearbyImageAlt);
  console.log('  year in harvest context    : ' + coverage.yearInHarvestContext);
  console.log('  exact slug text signal     : ' + coverage.bestExactSlug);
  console.log('  contains slug signal       : ' + coverage.bestContainsSlug);
  console.log('  recommendation             : ' + summary.recommendation);
  console.log('  private details            : ' + privateFile);
  console.log('  safe summary               : ' + summaryFile);
};

try {
  main();
} catch (error) {
  console.error('[TutorialHarvestContextAudit] ' + error.message);
  process.exitCode = 1;
}
