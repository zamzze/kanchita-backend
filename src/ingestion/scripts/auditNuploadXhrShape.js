'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } =
  require('../../modules/streams/http/safeHttpClient');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';
const MAX_HTML_BYTES = 512 * 1024;

const describePath = (value) => {
  try {
    const url = new URL(value, 'https://nupload.my');
    const segments = url.pathname.split('/').filter(Boolean);
    return {
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
      queryKeys: [...url.searchParams.keys()].sort(),
    };
  } catch {
    return { invalid: true };
  }
};

const extractInlineScripts = (html) => {
  const output = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) output.push(match[1] || '');
  return output;
};

const count = (text, regex) => [...text.matchAll(regex)].length;

const classifyExpression = (raw) => {
  const expression = String(raw || '').trim();
  if (!expression) return { kind: 'empty' };
  if (expression === 'null') return { kind: 'null' };
  if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
    return { kind: 'identifier', name: expression };
  }
  if (/^JSON\.stringify\s*\(/.test(expression)) {
    return { kind: 'json_stringify' };
  }
  if (/^(?:new\s+)?URLSearchParams\s*\(/.test(expression)) {
    return { kind: 'url_search_params' };
  }
  if (/^(?:new\s+)?FormData\s*\(/.test(expression)) {
    return { kind: 'form_data' };
  }
  const literal = /^(['"])([\s\S]*)\1$/.exec(expression);
  if (literal) {
    const value = literal[2];
    if (/^(?:https?:\/\/|\/)/i.test(value)) {
      return { kind: 'literal_path_or_url', shape: describePath(value) };
    }
    return { kind: 'literal_string', length: value.length };
  }
  if (/`/.test(expression)) return { kind: 'template_expression' };
  if (/\+/.test(expression)) return { kind: 'concatenation' };
  return { kind: 'other' };
};

const collectCallShapes = (text) => {
  const xhrOpen = [];
  const openRegex = /\.open\s*\(\s*(['"])(GET|POST)\1\s*,\s*([^,\r\n\)]+)/gi;
  for (const match of text.matchAll(openRegex)) {
    xhrOpen.push({
      method: match[2].toUpperCase(),
      endpoint: classifyExpression(match[3]),
    });
  }

  const fetchCalls = [];
  const fetchRegex = /\bfetch\s*\(\s*([^,\r\n\)]+)/gi;
  for (const match of text.matchAll(fetchRegex)) {
    fetchCalls.push({ endpoint: classifyExpression(match[1]) });
  }

  const headerNames = new Set();
  const headerRegex = /\.setRequestHeader\s*\(\s*(['"])([^'"\r\n]{1,128})\1/gi;
  for (const match of text.matchAll(headerRegex)) {
    headerNames.add(match[2].trim().toLowerCase());
  }

  const parameterNames = new Set();
  const parameterRegex = /\.(?:append|set)\s*\(\s*(['"])([A-Za-z0-9_.-]{1,64})\1/g;
  for (const match of text.matchAll(parameterRegex)) parameterNames.add(match[2]);

  const sendArguments = [];
  const sendRegex = /\.send\s*\(\s*([^\r\n\)]*)/gi;
  for (const match of text.matchAll(sendRegex)) {
    sendArguments.push(classifyExpression(match[1]));
  }

  const atobArguments = [];
  const atobRegex = /\batob\s*\(\s*([^\r\n\)]+)/gi;
  for (const match of text.matchAll(atobRegex)) {
    atobArguments.push(classifyExpression(match[1]));
  }

  return {
    xhrOpen,
    fetchCalls,
    requestHeaderNames: [...headerNames].sort(),
    requestParameterNames: [...parameterNames].sort(),
    sendArguments,
    atobArguments,
  };
};

const literalEndpointShapes = (text) => {
  const output = [];
  const regex = /(['"])((?:https?:\/\/|\/)[^'"\r\n]{1,1024})\1/g;
  for (const match of text.matchAll(regex)) {
    const value = match[2];
    if (/\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?)(?:$|[?#])/i.test(value)) continue;
    output.push(describePath(value));
    if (output.length >= 32) break;
  }
  const unique = new Map();
  for (const item of output) {
    const key = JSON.stringify(item);
    unique.set(key, (unique.get(key) || 0) + 1);
  }
  return [...unique.entries()].map(([key, occurrences]) => ({
    ...JSON.parse(key), occurrences,
  }));
};

const analyzeScript = (text, index) => {
  const calls = collectCallShapes(text);
  const playerKeys = [
    'file', 'sources', 'playlist', 'type', 'autostart', 'headers',
    'tracks', 'image', 'preload',
  ].filter((key) => new RegExp('\\b' + key + '\\s*:').test(text));

  return {
    index,
    bytes: Buffer.byteLength(text),
    signals: {
      xmlHttpRequestConstructors: count(text, /\bnew\s+XMLHttpRequest\s*\(/g),
      xhrOpenCalls: calls.xhrOpen.length,
      fetchCalls: calls.fetchCalls.length,
      sendCalls: count(text, /\.send\s*\(/g),
      setRequestHeaderCalls: count(text, /\.setRequestHeader\s*\(/g),
      atobCalls: count(text, /\batob\s*\(/g),
      jsonParseCalls: count(text, /\bJSON\.parse\s*\(/g),
      jsonStringifyCalls: count(text, /\bJSON\.stringify\s*\(/g),
      responseTextReads: count(text, /\.responseText\b/g),
      responseReads: count(text, /\.response\b/g),
      onloadAssignments: count(text, /\.onload\s*=/g),
      onreadystatechangeAssignments: count(text, /\.onreadystatechange\s*=/g),
      jwplayerSetupCalls: count(text, /\bjwplayer\s*\([^\)]*\)\s*\.setup\s*\(/g),
    },
    xhrOpen: calls.xhrOpen,
    fetch: calls.fetchCalls,
    requestHeaderNames: calls.requestHeaderNames,
    requestParameterNames: calls.requestParameterNames,
    sendArguments: calls.sendArguments,
    atobArguments: calls.atobArguments,
    literalEndpointShapes: literalEndpointShapes(text),
    playerConfigKeys: playerKeys,
  };
};

const loadWatchSample = async () => {
  const { rows } = await pool.query(
    `SELECT scs.iframe_url, sci.tutorial_url
     FROM source_catalog_servers scs
     JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id
     WHERE scs.is_active = TRUE
       AND sci.fetch_status = 'ok'
       AND sci.match_status = 'matched'
       AND sci.mapped_content_type = 'movie'
       AND sci.mapped_content_id IS NOT NULL
       AND scs.iframe_host = $1
       AND scs.iframe_url LIKE 'https://nupload.my/watch/%'
     ORDER BY scs.id ASC
     LIMIT 1`,
    [TARGET_HOST]
  );
  return rows[0] || null;
};

const main = async () => {
  const row = await loadWatchSample();
  if (!row) throw new Error('WATCH_SAMPLE_NOT_FOUND');

  const http = createSafeHttpClient({
    timeoutMs: 6000,
    maxBytes: MAX_HTML_BYTES,
    maxRedirects: 3,
  });

  const response = await http.get(row.iframe_url, {
    headers: {
      referer: row.tutorial_url,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
    timeoutMs: 6000,
    maxBytes: MAX_HTML_BYTES,
    maxRedirects: 3,
  });

  const type = String(response.headers?.['content-type'] || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (!response.ok || !['text/html', 'application/xhtml+xml'].includes(type)) {
    throw new Error('WATCH_HTML_NOT_AVAILABLE');
  }

  const scripts = extractInlineScripts(response.body.toString('utf8'));
  const analyses = scripts.map(analyzeScript);
  const relevant = analyses.filter((entry) =>
    entry.signals.xmlHttpRequestConstructors > 0 ||
    entry.signals.fetchCalls > 0 ||
    entry.signals.atobCalls > 0 ||
    entry.signals.jwplayerSetupCalls > 0
  );

  const aggregate = {
    inlineScripts: analyses.length,
    relevantScripts: relevant.length,
    xhrOpenCalls: relevant.reduce((n, s) => n + s.signals.xhrOpenCalls, 0),
    fetchCalls: relevant.reduce((n, s) => n + s.signals.fetchCalls, 0),
    atobCalls: relevant.reduce((n, s) => n + s.signals.atobCalls, 0),
    jwplayerSetupCalls: relevant.reduce((n, s) => n + s.signals.jwplayerSetupCalls, 0),
  };

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_XHR_SHAPE_AUDIT',
    safety: {
      databaseWrites: false,
      browserAutomation: false,
      javascriptExecuted: false,
      cookiesOrAuthentication: false,
      antiBotBypass: false,
      scriptBodiesStored: false,
      rawUrlsStored: false,
      dynamicValuesStored: false,
    },
    response: {
      status: response.status,
      contentType: type,
      bytes: response.body.length,
      redirects: response.redirects,
    },
    aggregate,
    scripts: relevant,
    recommendation:
      aggregate.xhrOpenCalls > 0
        ? 'XHR_WORKFLOW_SHAPE_IDENTIFIED'
        : aggregate.fetchCalls > 0
          ? 'FETCH_WORKFLOW_SHAPE_IDENTIFIED'
          : 'REQUEST_SHAPE_NOT_IDENTIFIED',
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-nupload-xhr-shape-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[NuploadXhrShapeAudit] Complete');
  console.log('  relevant inline scripts : ' + aggregate.relevantScripts);
  console.log('  XHR open calls          : ' + aggregate.xhrOpenCalls);
  console.log('  fetch calls             : ' + aggregate.fetchCalls);
  console.log('  atob calls              : ' + aggregate.atobCalls);
  console.log('  jwplayer setup calls    : ' + aggregate.jwplayerSetupCalls);
  console.log('  recommendation          : ' + summary.recommendation);
  console.log('  summary                 : ' + output);
};

main()
  .catch((error) => {
    console.error('[NuploadXhrShapeAudit] ' + (error?.code || error.message));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
