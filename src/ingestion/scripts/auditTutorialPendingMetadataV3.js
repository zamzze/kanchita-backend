'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const inputArg = argv.find((arg) => !arg.startsWith('--'));
const SAMPLE_PER_METHOD = Math.max(
  1,
  Number.parseInt(process.env.TUTORIAL_PENDING_METADATA_SAMPLE_PER_METHOD || '100', 10)
);
const DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.TUTORIAL_PENDING_METADATA_DELAY_MS || '150', 10)
);
const TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.TUTORIAL_PENDING_METADATA_TIMEOUT_MS || '15000', 10)
);

const PRIVATE_DIR = path.resolve(process.cwd(), 'data-private');
const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const DETAIL_FILE = path.join(PRIVATE_DIR, 'tutorial-pending-metadata-v3-private.json');
const SUMMARY_FILE = path.join(REPORT_DIR, 'tutorial-pending-metadata-v3-summary.json');
const TARGET_METHODS = [
  'ambiguous_exact',
  'fuzzy_candidates',
  'no_results',
  'local_anchor_ambiguous',
];

const ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,' +
  'image/avif,image/webp,image/apng,*/*;q=0.8';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeEntities = (value = '') => String(value)
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#x([0-9a-f]+);/gi, (raw, hex) => {
    const n = Number.parseInt(hex, 16);
    return Number.isFinite(n) ? String.fromCodePoint(n) : raw;
  })
  .replace(/&#([0-9]+);/g, (raw, dec) => {
    const n = Number.parseInt(dec, 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : raw;
  });

const stripTags = (value = '') => decodeEntities(String(value)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

const normalize = (value = '') => stripTags(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const parseAttributes = (raw = '') => {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    attrs[String(match[1] || '').toLowerCase()] =
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
};

const extractMeta = (html) => {
  const result = {};
  const re = /<meta\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && result[key] === undefined) {
      result[key] = String(attrs.content).trim();
    }
  }
  return result;
};

const firstTagText = (html, tag) => {
  const match = html.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return match ? stripTags(match[1]) : null;
};

const flattenJsonLd = (value, out = []) => {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const child of value) flattenJsonLd(child, out);
    return out;
  }
  out.push(value);
  if (Array.isArray(value['@graph'])) {
    for (const child of value['@graph']) flattenJsonLd(child, out);
  }
  return out;
};

const extractJsonLd = (html) => {
  const nodes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (String(attrs.type || '').toLowerCase() !== 'application/ld+json') continue;
    try {
      flattenJsonLd(JSON.parse(String(match[2] || '').trim()), nodes);
    } catch {}
  }

  let name = null;
  let headline = null;
  let datePublished = null;
  let image = null;
  let imdbId = null;
  let tmdbId = null;

  for (const node of nodes) {
    if (!name && typeof node.name === 'string') name = stripTags(node.name);
    if (!headline && typeof node.headline === 'string') headline = stripTags(node.headline);
    if (!datePublished && node.datePublished) datePublished = String(node.datePublished);
    if (!image && node.image) {
      if (typeof node.image === 'string') image = node.image;
      else if (Array.isArray(node.image) && typeof node.image[0] === 'string') image = node.image[0];
      else if (typeof node.image === 'object' && typeof node.image.url === 'string') image = node.image.url;
    }
    const serialized = JSON.stringify([node.identifier, node.sameAs, node.url]);
    if (!imdbId) {
      const m = serialized.match(/\btt\d{5,10}\b/i);
      if (m) imdbId = m[0];
    }
    if (!tmdbId) {
      const m = serialized.match(/tmdb[^0-9]{0,20}(\d{2,9})/i);
      if (m) tmdbId = Number(m[1]);
    }
  }

  return { name, headline, datePublished, image, imdbId, tmdbId, nodeCount: nodes.length };
};

const extractLiteralIds = (html) => {
  const imdb = html.match(/\btt\d{5,10}\b/i);
  const tmdb = html.match(/(?:tmdb[_\s-]*(?:id)?|tmdbId)[^0-9]{0,20}(\d{2,9})/i);
  return {
    imdbId: imdb ? imdb[0] : null,
    tmdbId: tmdb ? Number(tmdb[1]) : null,
  };
};

const extractYear = (...values) => {
  for (const value of values) {
    const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
};

const releaseYear = (value) => {
  const match = String(value || '').match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
};

const candidateTitleExact = (title, candidate) => {
  const t = normalize(title);
  if (!t) return false;
  return t === normalize(candidate?.title) || t === normalize(candidate?.originalTitle);
};

const basename = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://placeholder.invalid');
    return path.posix.basename(url.pathname || '') || null;
  } catch {
    return path.posix.basename(String(value).split('?')[0]) || null;
  }
};

const sampleEvenly = (records, count) => {
  if (records.length <= count) return [...records];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (records.length - 1)) / (count - 1));
    if (!seen.has(index)) {
      seen.add(index);
      out.push(records[index]);
    }
  }
  return out;
};

const addSlash = (raw) => {
  try {
    const u = new URL(raw);
    if (u.pathname.endsWith('/')) return null;
    u.pathname += '/';
    return u.toString();
  } catch {
    return null;
  }
};

const fetchHtml = async (rawUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const origin = new URL(rawUrl).origin + '/';
    let response = await fetch(rawUrl, {
      method: 'GET',
      headers: { Accept: ACCEPT, Referer: origin },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status === 404) {
      const slash = addSlash(rawUrl);
      if (slash) {
        response = await fetch(slash, {
          method: 'GET',
          headers: { Accept: ACCEPT, Referer: origin },
          redirect: 'follow',
          signal: controller.signal,
        });
      }
    }
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      bytes: body.length,
      html: body.toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
  }
};

const emptyStats = () => ({
  sampled: 0,
  http2xx: 0,
  html: 0,
  metadataTitle: 0,
  metadataTitleDifferentFromSlug: 0,
  yearFound: 0,
  imdbIdFound: 0,
  tmdbIdFound: 0,
  tmdbIdMatchesCandidate: 0,
  uniqueExactCandidateByMetadataTitle: 0,
  metadataYearDisambiguatesExactTitle: 0,
  uniquePosterPathMatch: 0,
  noResultsWithDifferentMetadataTitle: 0,
  networkErrors: 0,
});

const main = async () => {
  if (!inputArg) {
    throw new Error('Usage: npm run audit:tutorial-pending-metadata:v3 -- <tutorial-movie-matcher-v2-latest.json>');
  }
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ required');

  const inputFile = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputFile)) throw new Error('Input file not found: ' + inputFile);
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const records = Array.isArray(input.records) ? input.records : [];
  const byMethod = {};
  for (const method of TARGET_METHODS) {
    byMethod[method] = records.filter((record) => record?.matchV1?.method === method);
  }

  const sample = [];
  for (const method of TARGET_METHODS) {
    for (const record of sampleEvenly(byMethod[method], SAMPLE_PER_METHOD)) {
      sample.push({ method, record });
    }
  }

  const stats = Object.fromEntries(TARGET_METHODS.map((method) => [method, emptyStats()]));
  const totals = emptyStats();
  const details = [];

  console.log('[TutorialPendingMetadataV3] Starting');
  console.log('  mode              : READ_ONLY_METADATA_PILOT');
  console.log('  sample per method : ' + SAMPLE_PER_METHOD);
  console.log('  total sample      : ' + sample.length);
  console.log('  database writes   : false');
  console.log('  TMDB requests     : false');
  console.log('  iframe requests   : false');
  console.log('');

  for (let i = 0; i < sample.length; i += 1) {
    const { method, record } = sample[i];
    const counters = stats[method];
    counters.sampled += 1;
    totals.sampled += 1;

    let fetched;
    try {
      fetched = await fetchHtml(record.tutorialUrl);
    } catch (error) {
      counters.networkErrors += 1;
      totals.networkErrors += 1;
      details.push({ tutorialUrl: record.tutorialUrl, method, error: error?.name || 'Error' });
      continue;
    }

    if (fetched.status >= 200 && fetched.status < 300) {
      counters.http2xx += 1;
      totals.http2xx += 1;
    }
    if (/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) {
      counters.html += 1;
      totals.html += 1;
    }

    const html = fetched.html;
    const meta = extractMeta(html);
    const jsonLd = extractJsonLd(html);
    const literal = extractLiteralIds(html);
    const title = firstTagText(html, 'title');
    const h1 = firstTagText(html, 'h1');
    const metadataTitle = meta['og:title'] || jsonLd.name || jsonLd.headline || title || h1 || null;
    const metadataImage = meta['og:image'] || jsonLd.image || null;
    const year = extractYear(
      jsonLd.datePublished,
      metadataTitle,
      title,
      h1,
      meta.description,
      meta['og:description']
    );
    const imdbId = jsonLd.imdbId || literal.imdbId || null;
    const tmdbId = jsonLd.tmdbId || literal.tmdbId || null;
    const candidates = Array.isArray(record?.tmdb?.candidates) ? record.tmdb.candidates : [];
    const slugTitle = record?.slug?.titleRaw || record?.slug?.normalizedTitle || '';

    if (metadataTitle) {
      counters.metadataTitle += 1;
      totals.metadataTitle += 1;
      if (normalize(metadataTitle) !== normalize(slugTitle)) {
        counters.metadataTitleDifferentFromSlug += 1;
        totals.metadataTitleDifferentFromSlug += 1;
      }
    }
    if (year) {
      counters.yearFound += 1;
      totals.yearFound += 1;
    }
    if (imdbId) {
      counters.imdbIdFound += 1;
      totals.imdbIdFound += 1;
    }
    if (tmdbId) {
      counters.tmdbIdFound += 1;
      totals.tmdbIdFound += 1;
      if (candidates.some((candidate) => Number(candidate.id) === Number(tmdbId))) {
        counters.tmdbIdMatchesCandidate += 1;
        totals.tmdbIdMatchesCandidate += 1;
      }
    }

    const exactCandidates = metadataTitle
      ? candidates.filter((candidate) => candidateTitleExact(metadataTitle, candidate))
      : [];
    if (exactCandidates.length === 1) {
      counters.uniqueExactCandidateByMetadataTitle += 1;
      totals.uniqueExactCandidateByMetadataTitle += 1;
    }
    if (year && exactCandidates.length > 1) {
      const sameYear = exactCandidates.filter((candidate) => releaseYear(candidate.releaseDate) === year);
      if (sameYear.length === 1) {
        counters.metadataYearDisambiguatesExactTitle += 1;
        totals.metadataYearDisambiguatesExactTitle += 1;
      }
    }

    const imageBase = basename(metadataImage);
    if (imageBase && candidates.length) {
      const posterMatches = candidates.filter((candidate) => basename(candidate.posterPath) === imageBase);
      if (posterMatches.length === 1) {
        counters.uniquePosterPathMatch += 1;
        totals.uniquePosterPathMatch += 1;
      }
    }

    if (
      method === 'no_results' &&
      metadataTitle &&
      normalize(metadataTitle) !== normalize(slugTitle)
    ) {
      counters.noResultsWithDifferentMetadataTitle += 1;
      totals.noResultsWithDifferentMetadataTitle += 1;
    }

    details.push({
      tutorialUrl: record.tutorialUrl,
      method,
      httpStatus: fetched.status,
      bytes: fetched.bytes,
      slug: record.slug,
      metadata: {
        title,
        ogTitle: meta['og:title'] || null,
        h1,
        jsonLd,
        year,
        imdbId,
        tmdbId,
        image: metadataImage,
      },
      evidence: {
        metadataTitle,
        metadataTitleDifferentFromSlug: Boolean(metadataTitle) && normalize(metadataTitle) !== normalize(slugTitle),
        exactCandidateTmdbIds: exactCandidates.map((candidate) => Number(candidate.id)),
      },
    });

    if ((i + 1) === 1 || (i + 1) % 25 === 0 || (i + 1) === sample.length) {
      console.log('  ' + (i + 1) + '/' + sample.length + ' fetched');
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_PENDING_METADATA_V3_PILOT',
    databaseWrites: false,
    tmdbRequests: false,
    iframeRequests: false,
    tutorialPageRequests: true,
    rawTitlesStoredInSummary: false,
    rawUrlsStoredInSummary: false,
    samplePolicy: {
      perMethod: SAMPLE_PER_METHOD,
      methods: TARGET_METHODS,
      deterministicEvenSpacing: true,
    },
    populationByMethod: Object.fromEntries(
      TARGET_METHODS.map((method) => [method, byMethod[method].length])
    ),
    coverageByMethod: stats,
    totals,
    interpretation: {
      tmdbIdMatchesCandidate: 'Strong direct identity evidence already present in tutorial HTML.',
      metadataYearDisambiguatesExactTitle: 'Strong candidate discriminator for duplicate exact titles.',
      uniquePosterPathMatch: 'Potential strong discriminator if tutorial metadata reuses TMDB poster paths.',
      noResultsWithDifferentMetadataTitle: 'Candidates for a second TMDB search using page metadata instead of slug.',
      note: 'Sizing only. No automatic promotions are approved by this pilot.',
    },
    privateDetailFile: path.relative(process.cwd(), DETAIL_FILE),
  };

  fs.writeFileSync(DETAIL_FILE, JSON.stringify({ generatedAt: summary.generatedAt, records: details }, null, 2), 'utf8');
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialPendingMetadataV3] Complete');
  console.log('  sampled             : ' + totals.sampled);
  console.log('  http 2xx            : ' + totals.http2xx);
  console.log('  metadata title      : ' + totals.metadataTitle);
  console.log('  title != slug       : ' + totals.metadataTitleDifferentFromSlug);
  console.log('  year found          : ' + totals.yearFound);
  console.log('  IMDb IDs            : ' + totals.imdbIdFound);
  console.log('  TMDB IDs            : ' + totals.tmdbIdFound);
  console.log('  TMDB ID candidate   : ' + totals.tmdbIdMatchesCandidate);
  console.log('  metadata exact uniq : ' + totals.uniqueExactCandidateByMetadataTitle);
  console.log('  year disambiguates  : ' + totals.metadataYearDisambiguatesExactTitle);
  console.log('  poster unique       : ' + totals.uniquePosterPathMatch);
  console.log('  no-results new title: ' + totals.noResultsWithDifferentMetadataTitle);
  console.log('  summary             : ' + SUMMARY_FILE);
};

main().catch((error) => {
  console.error('[TutorialPendingMetadataV3] ' + error.message);
  process.exitCode = 1;
});
