'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } =
  require('../../modules/streams/http/safeHttpClient');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';
const MAX_HTML_BYTES = 512 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SAME_ORIGIN_SCRIPTS = 3;
const MAX_LITERAL_URLS = 64;
const MAX_BASE64_CANDIDATES = 64;

const SIGNALS = Object.freeze([
  'm3u8', 'mp4', 'jwplayer', 'hls', 'fetch(', 'xmlhttprequest',
  'axios', 'atob(', 'btoa(', 'eval(', 'player', 'sources',
  'source', 'file', 'playlist', 'manifest', 'token', 'iframe',
]);

const countOccurrences = (text, needle) => {
  const haystack = String(text || '').toLowerCase();
  const target = String(needle || '').toLowerCase();
  if (!target) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(target, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + target.length;
  }
};

const signalSummary = (text) => Object.fromEntries(
  SIGNALS
    .map((signal) => [signal, countOccurrences(text, signal)])
    .filter(([, count]) => count > 0)
);

const describeUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return {
      scheme: url.protocol.slice(0, -1),
      host: url.hostname.toLowerCase(),
      pathShape: segments.map((segment) => {
        if (/^\d+$/.test(segment)) return ':num';
        if (/^[0-9a-f]{8,}$/i.test(segment)) return ':hex';
        if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) return ':token';
        if (segment.includes('.')) {
          return ':file.' + segment.split('.').pop().toLowerCase();
        }
        return segment.length > 24 ? ':long' : segment.toLowerCase();
      }).join('/'),
      hasQuery: url.search.length > 0,
      queryKeyCount: [...url.searchParams.keys()].length,
    };
  } catch {
    return { invalid: true };
  }
};

const aggregateDescriptions = (values) => {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((a, b) => b.count - a.count);
};

const loadSample = async (shape) => {
  const prefix = shape === 'watch_token'
    ? 'https://nupload.my/watch/%'
    : 'https://nupload.my/iframe%';

  const sql =
    'SELECT scs.iframe_url, scs.server_index, sci.tutorial_url ' +
    'FROM source_catalog_servers scs ' +
    'JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id ' +
    "WHERE scs.is_active = TRUE AND sci.fetch_status = 'ok' " +
    "AND sci.match_status = 'matched' " +
    "AND sci.mapped_content_type = 'movie' " +
    'AND sci.mapped_content_id IS NOT NULL ' +
    'AND scs.iframe_host = $1 AND scs.iframe_url LIKE $2 ' +
    'ORDER BY scs.id ASC LIMIT 100';

  const { rows } = await pool.query(sql, [TARGET_HOST, prefix]);

  for (const row of rows) {
    try {
      const url = new URL(row.iframe_url);
      const pathname = url.pathname.replace(/\/+$/, '');
      if (shape === 'watch_token' &&
          pathname.startsWith('/watch/') &&
          url.search.length === 0) return row;
      if (shape === 'iframe_query' &&
          pathname === '/iframe' &&
          url.search.length > 0) return row;
    } catch {
      // Ignore malformed candidates.
    }
  }
  return null;
};

const extractTagStats = (html) => {
  const tags = {};
  const dataAttributes = {};
  const inputTypes = {};
  const scriptSrcs = [];
  let inlineScripts = 0;
  let externalScripts = 0;
  let forms = 0;

  const tagRegex = /<([a-z][a-z0-9:-]*)(\s[^<>]*?)?>/gi;
  for (const match of html.matchAll(tagRegex)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || '';
    tags[tag] = (tags[tag] || 0) + 1;

    if (tag === 'form') forms += 1;
    if (tag === 'input') {
      const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const type = String(typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? 'text')
        .toLowerCase();
      inputTypes[type] = (inputTypes[type] || 0) + 1;
    }

    for (const attrMatch of attrs.matchAll(/\b(data-[a-z0-9_:-]+)\s*=/gi)) {
      const name = attrMatch[1].toLowerCase();
      dataAttributes[name] = (dataAttributes[name] || 0) + 1;
    }

    if (tag === 'script') {
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? null;
      if (src) {
        externalScripts += 1;
        scriptSrcs.push(src);
      } else {
        inlineScripts += 1;
      }
    }
  }

  return { tags, forms, inputTypes, dataAttributes,
    inlineScripts, externalScripts, scriptSrcs };
};

const extractInlineScriptText = (html) => {
  const blocks = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) blocks.push(match[1] || '');
  return blocks.join('\n');
};

const extractLiteralUrlShapes = (text, baseUrl) => {
  const output = [];
  const regex = /https?:\/\/[^\s"'<>\\]{4,4096}/gi;
  for (const match of String(text || '').matchAll(regex)) {
    try {
      output.push(describeUrl(new URL(match[0], baseUrl).toString()));
      if (output.length >= MAX_LITERAL_URLS) break;
    } catch {
      // Ignore malformed URL literal.
    }
  }
  return aggregateDescriptions(output);
};

const extractBase64UrlShapes = (text) => {
  const output = [];
  const candidates = String(text || '').match(/[A-Za-z0-9+/_-]{24,4096}={0,2}/g) || [];
  let inspected = 0;

  for (const candidate of candidates) {
    if (inspected >= MAX_BASE64_CANDIDATES) break;
    inspected += 1;
    for (const encoding of ['base64', 'base64url']) {
      try {
        const decoded = Buffer.from(candidate, encoding).toString('utf8').trim();
        if (!/^https?:\/\//i.test(decoded)) continue;
        output.push(describeUrl(decoded));
        break;
      } catch {
        // Ignore non-decodable values.
      }
    }
  }

  return {
    candidatesSeen: candidates.length,
    candidatesInspected: inspected,
    decodedHttpUrlShapes: aggregateDescriptions(output),
  };
};

const resolveScriptUrls = (scriptSrcs, baseUrl) => {
  const output = [];
  for (const src of scriptSrcs) {
    try {
      const url = new URL(src, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) ||
          url.username || url.password) continue;
      output.push(url);
    } catch {
      // Ignore invalid script src.
    }
  }
  return output;
};

const inspectSameOriginScripts = async (http, scriptUrls, pageUrl) => {
  const pageOrigin = new URL(pageUrl).origin;
  const discovered = scriptUrls.filter((url) => url.origin === pageOrigin);
  const selected = discovered.slice(0, MAX_SAME_ORIGIN_SCRIPTS);
  const scripts = [];

  for (const scriptUrl of selected) {
    const entry = {
      url: describeUrl(scriptUrl.toString()),
      status: null,
      contentType: null,
      bytes: 0,
      signals: {},
      literalUrlShapes: [],
      base64: null,
      errorCode: null,
    };

    try {
      const response = await http.get(scriptUrl.toString(), {
        headers: { referer: pageUrl, accept: '*/*' },
        timeoutMs: 6000,
        maxBytes: MAX_SCRIPT_BYTES,
        maxRedirects: 3,
      });
      entry.status = response.status;
      entry.contentType = String(response.headers?.['content-type'] || '')
        .split(';', 1)[0].trim().toLowerCase() || null;
      entry.bytes = response.body?.length || 0;

      if (response.ok) {
        const text = response.body.toString('utf8');
        entry.signals = signalSummary(text);
        entry.literalUrlShapes = extractLiteralUrlShapes(text, response.url);
        entry.base64 = extractBase64UrlShapes(text);
      }
    } catch (error) {
      entry.errorCode = typeof error?.code === 'string'
        ? error.code : 'SCRIPT_FETCH_ERROR';
    }
    scripts.push(entry);
  }

  return {
    sameOriginDiscovered: discovered.length,
    fetched: scripts.length,
    scripts,
  };
};

const inspectSample = async (shape, row, http) => {
  if (!row) return {
    shape, found: false, recommendation: 'SOURCE_SHAPE_NOT_FOUND',
  };

  const result = {
    shape,
    found: true,
    serverIndex: Number(row.server_index),
    source: describeUrl(row.iframe_url),
    response: null,
    html: null,
    sameOriginScripts: null,
    recommendation: null,
  };

  let response;
  try {
    response = await http.get(row.iframe_url, {
      headers: {
        referer: row.tutorial_url,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: 6000,
      maxBytes: MAX_HTML_BYTES,
      maxRedirects: 3,
    });
  } catch (error) {
    result.response = {
      errorCode: typeof error?.code === 'string'
        ? error.code : 'HTML_FETCH_ERROR',
    };
    result.recommendation = 'NETWORK_REVIEW_REQUIRED';
    return result;
  }

  const contentType = String(response.headers?.['content-type'] || '')
    .split(';', 1)[0].trim().toLowerCase();

  result.response = {
    ok: response.ok,
    status: response.status,
    contentType: contentType || null,
    bytes: response.body?.length || 0,
    redirects: response.redirects,
    finalUrl: describeUrl(response.url),
  };

  if (!response.ok ||
      !['text/html', 'application/xhtml+xml'].includes(contentType)) {
    result.recommendation = response.ok
      ? 'NON_HTML_RESPONSE'
      : [401, 403].includes(response.status)
        ? 'UNSUPPORTED_ACCESS_SEMANTICS'
        : 'HTTP_FAILURE';
    return result;
  }

  const html = response.body.toString('utf8');
  const tagStats = extractTagStats(html);
  const inlineScriptText = extractInlineScriptText(html);
  const scriptUrls = resolveScriptUrls(tagStats.scriptSrcs, response.url);

  result.html = {
    tags: tagStats.tags,
    forms: tagStats.forms,
    inputTypes: tagStats.inputTypes,
    dataAttributes: tagStats.dataAttributes,
    inlineScripts: tagStats.inlineScripts,
    externalScripts: tagStats.externalScripts,
    scriptUrlShapes: aggregateDescriptions(
      scriptUrls.map((url) => describeUrl(url.toString()))
    ),
    documentSignals: signalSummary(html),
    inlineScriptSignals: signalSummary(inlineScriptText),
    literalUrlShapes: extractLiteralUrlShapes(html, response.url),
    base64: extractBase64UrlShapes(html),
  };

  result.sameOriginScripts = await inspectSameOriginScripts(
    http, scriptUrls, response.url
  );

  const externalSignals = result.sameOriginScripts.scripts.reduce((acc, script) => {
    for (const [key, count] of Object.entries(script.signals || {})) {
      acc[key] = (acc[key] || 0) + count;
    }
    return acc;
  }, {});

  const doc = result.html.documentSignals;
  const inline = result.html.inlineScriptSignals;
  const decodedCount = result.html.base64.decodedHttpUrlShapes
    .reduce((sum, item) => sum + item.count, 0);

  const hasMediaLiteral =
    (doc.m3u8 || 0) + (doc.mp4 || 0) + decodedCount > 0;
  const hasHttpWorkflowSignal =
    (inline['fetch('] || 0) + (inline.xmlhttprequest || 0) +
    (inline.axios || 0) + (externalSignals['fetch('] || 0) +
    (externalSignals.xmlhttprequest || 0) + (externalSignals.axios || 0) > 0;
  const hasBase64Signal =
    (inline['atob('] || 0) + (externalSignals['atob('] || 0) +
    decodedCount > 0;

  if (hasMediaLiteral) {
    result.recommendation =
      'STATIC_LITERAL_OR_BASE64_MEDIA_EXTRACTION_CANDIDATE';
  } else if (hasHttpWorkflowSignal) {
    result.recommendation = 'HTTP_WORKFLOW_PROVIDER_CANDIDATE';
  } else if (hasBase64Signal) {
    result.recommendation = 'BOUNDED_BASE64_WORKFLOW_CANDIDATE';
  } else if (tagStats.forms > 0) {
    result.recommendation = 'FORM_WORKFLOW_REVIEW';
  } else {
    result.recommendation = 'STATIC_STRUCTURE_INSUFFICIENT_REVIEW_REQUIRED';
  }

  return result;
};

const main = async () => {
  const [watch, iframe] = await Promise.all([
    loadSample('watch_token'),
    loadSample('iframe_query'),
  ]);

  const http = createSafeHttpClient({
    timeoutMs: 6000,
    maxBytes: MAX_HTML_BYTES,
    maxRedirects: 3,
  });

  const samples = [
    await inspectSample('watch_token', watch, http),
    await inspectSample('iframe_query', iframe, http),
  ];

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_HTML_STRUCTURE_AUDIT',
    safety: {
      databaseWrites: false,
      browserAutomation: false,
      cookiesOrAuthentication: false,
      antiBotBypass: false,
      htmlBodiesStored: false,
      scriptBodiesStored: false,
      rawUrlsStored: false,
      sourceSamples: 2,
      sameOriginScriptsPerSampleMax: MAX_SAME_ORIGIN_SCRIPTS,
    },
    samples,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(
    REPORT_DIR,
    'tutorial-nupload-html-structure-summary.json'
  );
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[NuploadHtmlStructureAudit] Complete');
  for (const sample of samples) {
    console.log(
      '  ' + sample.shape +
      ' | found=' + sample.found +
      ' | recommendation=' + sample.recommendation
    );
  }
  console.log('  summary: ' + output);
};

main()
  .catch((error) => {
    console.error('[NuploadHtmlStructureAudit] ' + (error?.code || error.message));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
