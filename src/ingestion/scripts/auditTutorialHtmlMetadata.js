'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SAMPLE_SIZE = Math.max(
  1,
  Number.parseInt(process.env.TUTORIAL_METADATA_SAMPLE_SIZE || '50', 10)
);
const TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.TUTORIAL_METADATA_TIMEOUT_MS || '15000', 10)
);
const DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.TUTORIAL_METADATA_DELAY_MS || '250', 10)
);

const FIXED_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,' +
  'image/avif,image/webp,image/apng,*/*;q=0.8,' +
  'application/signed-exchange;v=b3;q=0.7';

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtmlEntities = (value = '') => String(value)
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#x([0-9a-f]+);/gi, (original, hex) => {
    const n = Number.parseInt(hex, 16);
    return Number.isFinite(n) ? String.fromCodePoint(n) : original;
  })
  .replace(/&#([0-9]+);/g, (original, dec) => {
    const n = Number.parseInt(dec, 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : original;
  });

const stripTags = (value = '') => decodeHtmlEntities(
  String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

const normalizeText = (value = '') => stripTags(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const extractYear = (...values) => {
  for (const value of values) {
    const match = String(value ?? '').match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
};

const parseAttributes = (raw = '') => {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    attrs[String(match[1] || '').toLowerCase()] =
      decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
};

const extractTitle = (html) => {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : null;
};

const extractH1 = (html) => {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripTags(match[1]) : null;
};

const extractMeta = (html) => {
  const result = {};
  const re = /<meta\b([^>]*)>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (!key || attrs.content === undefined || result[key] !== undefined) continue;
    result[key] = String(attrs.content).trim();
  }

  return result;
};

const extractCanonical = (html) => {
  const re = /<link\b([^>]*)>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (String(attrs.rel || '').toLowerCase() === 'canonical' && attrs.href) {
      return String(attrs.href).trim();
    }
  }

  return null;
};

const flattenJsonLd = (value, output = []) => {
  if (!value || typeof value !== 'object') return output;

  if (Array.isArray(value)) {
    for (const child of value) flattenJsonLd(child, output);
    return output;
  }

  output.push(value);

  if (Array.isArray(value['@graph'])) {
    for (const child of value['@graph']) flattenJsonLd(child, output);
  }

  return output;
};

const extractJsonLd = (html) => {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (String(attrs.type || '').toLowerCase() !== 'application/ld+json') continue;

    const raw = String(match[2] || '').trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      blocks.push(...flattenJsonLd(parsed));
    } catch {
      blocks.push({ __parse_error: true });
    }
  }

  const types = [];
  let name = null;
  let headline = null;
  let datePublished = null;
  let image = null;
  let imdbId = null;
  let tmdbId = null;
  let parseErrors = 0;

  for (const node of blocks) {
    if (node.__parse_error) {
      parseErrors += 1;
      continue;
    }

    const rawTypes = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    for (const type of rawTypes.filter(Boolean)) {
      types.push(String(type));
    }

    if (!name && typeof node.name === 'string') name = stripTags(node.name);
    if (!headline && typeof node.headline === 'string') headline = stripTags(node.headline);
    if (!datePublished && node.datePublished) datePublished = String(node.datePublished);

    if (!image && node.image) {
      if (typeof node.image === 'string') image = node.image;
      else if (Array.isArray(node.image) && typeof node.image[0] === 'string') image = node.image[0];
      else if (typeof node.image === 'object' && typeof node.image.url === 'string') image = node.image.url;
    }

    const identifiers = [];
    if (node.identifier !== undefined) identifiers.push(node.identifier);
    if (node.sameAs !== undefined) identifiers.push(node.sameAs);
    const serialized = JSON.stringify(identifiers);

    if (!imdbId) {
      const imdbMatch = serialized.match(/\btt\d{5,10}\b/i);
      if (imdbMatch) imdbId = imdbMatch[0];
    }

    if (!tmdbId) {
      const tmdbMatch = serialized.match(/tmdb[^0-9]{0,20}(\d{2,9})/i);
      if (tmdbMatch) tmdbId = tmdbMatch[1];
    }
  }

  return {
    blockCount: blocks.length,
    parseErrors,
    types: [...new Set(types)].sort(),
    name,
    headline,
    datePublished,
    image,
    imdbId,
    tmdbId,
  };
};

const extractLiteralIds = (html) => {
  const imdbMatches = [...html.matchAll(/\btt\d{5,10}\b/gi)].map((m) => m[0]);
  const tmdbMatches = [...html.matchAll(
    /(?:tmdb[_\s-]*(?:id)?|tmdbId)[^0-9]{0,20}(\d{2,9})/gi
  )].map((m) => m[1]);

  return {
    imdbIds: [...new Set(imdbMatches)],
    tmdbIds: [...new Set(tmdbMatches)],
  };
};

const deriveSlugTitle = (tutorialUrl) => {
  try {
    const url = new URL(tutorialUrl);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return null;
  }
};

const addTrailingSlash = (raw) => {
  try {
    const url = new URL(raw);
    if (url.pathname.endsWith('/')) return null;
    url.pathname += '/';
    return url.toString();
  } catch {
    return null;
  }
};

const requestHtml = async (url, referer) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Referer: referer,
        Accept: FIXED_ACCEPT,
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    const body = Buffer.from(await response.arrayBuffer());
    return {
      url,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      bytes: body.length,
      html: body.toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
  }
};

const fetchTutorial = async (record) => {
  const initialUrl = record.requestUrlUsed || record.tutorialUrl;
  let result = await requestHtml(initialUrl, record.refererUrl);

  if (result.status === 404) {
    const slash = addTrailingSlash(record.tutorialUrl);
    if (slash && slash !== initialUrl) {
      result = await requestHtml(slash, record.refererUrl);
    }
  }

  return result;
};

const sampleEvenly = (records, count) => {
  if (records.length <= count) return [...records];

  const selected = [];
  const seen = new Set();

  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (records.length - 1)) / (count - 1));
    if (!seen.has(index)) {
      seen.add(index);
      selected.push(records[index]);
    }
  }

  return selected;
};

const inc = (map, key) => {
  map[key] = (map[key] || 0) + 1;
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run audit:tutorial-html-metadata -- <tutorial-server-extraction-latest.json>'
    );
  }

  if (typeof fetch !== 'function') {
    throw new Error('Node.js 18+ required');
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const extraction = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const eligible = (extraction.records || [])
    .filter((record) => record.status === 'ok' && record.tutorialUrl && record.refererUrl)
    .sort((a, b) => String(a.tutorialUrl).localeCompare(String(b.tutorialUrl)));

  const sample = sampleEvenly(eligible, SAMPLE_SIZE);

  const coverage = {
    requested: sample.length,
    http2xx: 0,
    htmlContentType: 0,
    title: 0,
    ogTitle: 0,
    twitterTitle: 0,
    h1: 0,
    metaDescription: 0,
    ogDescription: 0,
    ogImage: 0,
    twitterImage: 0,
    canonical: 0,
    jsonLd: 0,
    jsonLdName: 0,
    jsonLdHeadline: 0,
    jsonLdDatePublished: 0,
    jsonLdImage: 0,
    year: 0,
    imdbId: 0,
    tmdbId: 0,
    slugMetadataExact: 0,
    slugMetadataContains: 0,
  };

  const httpStatuses = {};
  const schemaTypes = {};
  const privateRecords = [];

  console.log('[TutorialHtmlMetadataAudit] Starting');
  console.log(`  eligible : ${eligible.length}`);
  console.log(`  sample   : ${sample.length}`);
  console.log('  no iframe destinations will be requested');
  console.log('');

  for (let i = 0; i < sample.length; i += 1) {
    const source = sample[i];
    let fetched;

    try {
      fetched = await fetchTutorial(source);
    } catch (error) {
      privateRecords.push({
        tutorialUrl: source.tutorialUrl,
        refererUrl: source.refererUrl,
        error: error?.name || 'Error',
      });
      inc(httpStatuses, 'network_error');
      continue;
    }

    inc(httpStatuses, String(fetched.status));
    if (fetched.status >= 200 && fetched.status <= 299) coverage.http2xx += 1;

    const isHtml = /text\/html|application\/xhtml\+xml/i.test(fetched.contentType);
    if (isHtml) coverage.htmlContentType += 1;

    const html = fetched.html;
    const meta = extractMeta(html);
    const jsonLd = extractJsonLd(html);
    const literalIds = extractLiteralIds(html);

    const title = extractTitle(html);
    const ogTitle = meta['og:title'] || null;
    const twitterTitle = meta['twitter:title'] || null;
    const h1 = extractH1(html);
    const description = meta.description || null;
    const ogDescription = meta['og:description'] || null;
    const ogImage = meta['og:image'] || null;
    const twitterImage = meta['twitter:image'] || meta['twitter:image:src'] || null;
    const canonical = extractCanonical(html);

    const imdbId = jsonLd.imdbId || literalIds.imdbIds[0] || null;
    const tmdbId = jsonLd.tmdbId || literalIds.tmdbIds[0] || null;

    const year = extractYear(
      jsonLd.datePublished,
      ogTitle,
      title,
      h1,
      description,
      ogDescription
    );

    if (title) coverage.title += 1;
    if (ogTitle) coverage.ogTitle += 1;
    if (twitterTitle) coverage.twitterTitle += 1;
    if (h1) coverage.h1 += 1;
    if (description) coverage.metaDescription += 1;
    if (ogDescription) coverage.ogDescription += 1;
    if (ogImage) coverage.ogImage += 1;
    if (twitterImage) coverage.twitterImage += 1;
    if (canonical) coverage.canonical += 1;
    if (jsonLd.blockCount > 0) coverage.jsonLd += 1;
    if (jsonLd.name) coverage.jsonLdName += 1;
    if (jsonLd.headline) coverage.jsonLdHeadline += 1;
    if (jsonLd.datePublished) coverage.jsonLdDatePublished += 1;
    if (jsonLd.image) coverage.jsonLdImage += 1;
    if (year) coverage.year += 1;
    if (imdbId) coverage.imdbId += 1;
    if (tmdbId) coverage.tmdbId += 1;

    for (const type of jsonLd.types) inc(schemaTypes, type);

    const slugTitle = deriveSlugTitle(source.tutorialUrl);
    const metadataTitle = ogTitle || jsonLd.name || jsonLd.headline || title || h1;
    const normalizedSlug = normalizeText(slugTitle);
    const normalizedMetadata = normalizeText(metadataTitle);

    let titleRelationship = null;
    if (normalizedSlug && normalizedMetadata) {
      if (normalizedSlug === normalizedMetadata) {
        titleRelationship = 'exact';
        coverage.slugMetadataExact += 1;
      } else if (
        normalizedSlug.includes(normalizedMetadata) ||
        normalizedMetadata.includes(normalizedSlug)
      ) {
        titleRelationship = 'contains';
        coverage.slugMetadataContains += 1;
      } else {
        titleRelationship = 'different';
      }
    }

    privateRecords.push({
      tutorialUrl: source.tutorialUrl,
      requestUrlUsed: fetched.url,
      refererUrl: source.refererUrl,
      httpStatus: fetched.status,
      bytes: fetched.bytes,
      metadata: {
        title,
        ogTitle,
        twitterTitle,
        h1,
        description,
        ogDescription,
        ogImage,
        twitterImage,
        canonical,
        jsonLd,
        literalIds,
        year,
        imdbId,
        tmdbId,
        titleRelationship,
      },
    });

    const current = i + 1;
    if (current === 1 || current % 10 === 0 || current === sample.length) {
      console.log(
        `  ${current}/${sample.length} | 2xx=${coverage.http2xx} ` +
        `og:title=${coverage.ogTitle} h1=${coverage.h1} ` +
        `jsonld=${coverage.jsonLd} year=${coverage.year}`
      );
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const topSchemaTypes = Object.entries(schemaTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([type, count]) => ({ type, count }));

  const summary = {
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTitlesStoredInSummary: false,
      rawUrlsStoredInSummary: false,
      rawImagesStoredInSummary: false,
      rawDescriptionsStoredInSummary: false,
      privateDetailFileContainsRealValues: true,
      javascriptExecuted: false,
      iframeDestinationsRequested: false,
    },
    population: {
      eligibleOkTutorials: eligible.length,
      sampleSize: sample.length,
      sampling: 'deterministic_evenly_spaced_by_tutorial_url',
    },
    httpStatuses,
    coverage,
    jsonLd: {
      topSchemaTypes,
    },
    recommendation: null,
  };

  if (
    coverage.ogTitle >= sample.length * 0.8 ||
    coverage.jsonLdName >= sample.length * 0.8
  ) {
    summary.recommendation = 'STRUCTURED_TITLE_METADATA_AVAILABLE';
  } else if (
    coverage.title >= sample.length * 0.8 ||
    coverage.h1 >= sample.length * 0.8
  ) {
    summary.recommendation = 'HTML_TITLE_METADATA_AVAILABLE';
  } else {
    summary.recommendation = 'URL_SLUG_REMAINS_PRIMARY_TITLE_SOURCE';
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const privateFile = path.join(PRIVATE_DIR, 'tutorial-html-metadata-private.json');
  const summaryFile = path.join(REPORT_DIR, 'tutorial-html-metadata-summary.json');

  fs.writeFileSync(
    privateFile,
    JSON.stringify({ generatedAt: summary.generatedAt, records: privateRecords }, null, 2),
    'utf8'
  );

  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log('[TutorialHtmlMetadataAudit] Complete');
  console.log(`  sample          : ${sample.length}`);
  console.log(`  HTTP 2xx        : ${coverage.http2xx}`);
  console.log(`  <title>         : ${coverage.title}`);
  console.log(`  og:title        : ${coverage.ogTitle}`);
  console.log(`  twitter:title   : ${coverage.twitterTitle}`);
  console.log(`  h1              : ${coverage.h1}`);
  console.log(`  og:image        : ${coverage.ogImage}`);
  console.log(`  JSON-LD         : ${coverage.jsonLd}`);
  console.log(`  JSON-LD name    : ${coverage.jsonLdName}`);
  console.log(`  year            : ${coverage.year}`);
  console.log(`  IMDb ID         : ${coverage.imdbId}`);
  console.log(`  TMDB ID         : ${coverage.tmdbId}`);
  console.log(`  slug=metadata   : ${coverage.slugMetadataExact}`);
  console.log(`  recommendation  : ${summary.recommendation}`);
  console.log(`  private details : ${privateFile}`);
  console.log(`  safe summary    : ${summaryFile}`);
};

main().catch((error) => {
  console.error(`[TutorialHtmlMetadataAudit] ${error.message}`);
  process.exitCode = 1;
});
