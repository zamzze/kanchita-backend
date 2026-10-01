'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } =
  require('../../modules/streams/http/safeHttpClient');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';
const MAX_HTML_BYTES = 512 * 1024;

const extractInlineScripts = (html) => {
  const output = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) output.push(match[1] || '');
  return output;
};

const sanitize = (text) => String(text || '')
  .replace(/https?:\/\/[^\s'"`<>]+/gi, '<url>')
  .replace(/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, (_m) => '<str>')
  .replace(/`(?:\\.|[^`])*`/g, '<template>')
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
  .replace(/\b\d{4,}\b/g, '<num>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500);

const contextsFor = (text, needle, radius = 180, limit = 8) => {
  const output = [];
  let offset = 0;
  while (output.length < limit) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + needle.length + radius);
    output.push(sanitize(text.slice(start, end)));
    offset = index + needle.length;
  }
  return [...new Set(output)];
};

const functionParamUses = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const output = [];
  const patterns = [
    new RegExp('function\\s*[A-Za-z_$]*\\s*\\(([^\\)]*)\\)', 'g'),
    new RegExp('\\(([^\\)]*)\\)\\s*=>', 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const params = match[1].split(',').map((v) => v.trim()).filter(Boolean);
      if (params.includes(name)) output.push({ kind: 'function_parameter', parameterIndex: params.indexOf(name) });
    }
  }
  const singleArrow = new RegExp('(?:^|[^\\w$])' + escaped + '\\s*=>', 'g');
  if (singleArrow.test(text)) output.push({ kind: 'arrow_parameter', parameterIndex: 0 });
  return output;
};

const declarationUses = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const output = [];
  const re = new RegExp('(?:var|let|const)\\s+' + escaped + '(?:\\s*=\\s*([^;\\r\\n]+))?', 'g');
  for (const match of text.matchAll(re)) {
    output.push({
      kind: 'declaration',
      initialized: Boolean(match[1]),
      initializerShape: match[1] ? sanitize(match[1]) : null,
    });
  }
  return output;
};

const assignmentUses = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const output = [];
  const re = new RegExp('(?:^|[;{}\\r\\n,])\\s*' + escaped + '\\s*=\\s*([^;\\r\\n,]{1,500})', 'g');
  for (const match of text.matchAll(re)) {
    output.push({ kind: 'assignment', rhsShape: sanitize(match[1]) });
  }
  return output;
};

const propertyAssignments = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const output = [];
  const re = new RegExp('(?:[A-Za-z_$][\\w$]*\\.)?' + escaped + '\\s*:\\s*([^,}]{1,300})', 'g');
  for (const match of text.matchAll(re)) {
    output.push({ kind: 'object_property', valueShape: sanitize(match[1]) });
  }
  return output;
};

const genericResponseSignals = (text) => ({
  responseText: [...text.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.responseText\b/g)].length,
  response: [...text.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.response\b/g)].length,
  responseJSON: [...text.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.responseJSON\b/g)].length,
  readyState: [...text.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.readyState\b/g)].length,
  status: [...text.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.status\b/g)].length,
  onreadystatechange: [...text.matchAll(/\.onreadystatechange\s*=/g)].length,
  onload: [...text.matchAll(/\.onload\s*=/g)].length,
  onloadend: [...text.matchAll(/\.onloadend\s*=/g)].length,
  addEventListenerLoad: [...text.matchAll(/\.addEventListener\s*\(\s*['"]load['"]/g)].length,
  addEventListenerReady: [...text.matchAll(/\.addEventListener\s*\(\s*['"]readystatechange['"]/g)].length,
});

const callbackShapes = (text) => {
  const output = [];
  const patterns = [
    /(?:success|complete|done|then|each|map|forEach)\s*\(\s*function\s*\(([^\)]*)\)/g,
    /(?:success|complete|done|then|each|map|forEach)\s*\(\s*\(([^\)]*)\)\s*=>/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const params = match[1].split(',').map((v) => v.trim()).filter(Boolean);
      output.push({ parameterCount: params.length, parameters: params.slice(0, 6) });
    }
  }
  return output;
};

const inspectIdentifier = (text, name) => ({
  identifier: name,
  functionParameters: functionParamUses(text, name),
  declarations: declarationUses(text, name),
  assignments: assignmentUses(text, name),
  objectProperties: propertyAssignments(text, name),
  contexts: contextsFor(text, name),
});

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

  const http = createSafeHttpClient({ timeoutMs: 6000, maxBytes: MAX_HTML_BYTES, maxRedirects: 3 });
  const response = await http.get(row.iframe_url, {
    headers: { referer: row.tutorial_url, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    timeoutMs: 6000, maxBytes: MAX_HTML_BYTES, maxRedirects: 3,
  });

  const type = String(response.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!response.ok || !['text/html', 'application/xhtml+xml'].includes(type)) {
    throw new Error('WATCH_HTML_NOT_AVAILABLE');
  }

  const scripts = extractInlineScripts(response.body.toString('utf8'));
  const selected = scripts
    .map((text, index) => ({ text, index }))
    .filter((item) => /\.open\s*\(|\batob\s*\(/.test(item.text));

  const analyses = selected.map((item) => ({
    scriptIndex: item.index,
    bytes: Buffer.byteLength(item.text),
    identifiers: [inspectIdentifier(item.text, 'o'), inspectIdentifier(item.text, 'value')],
    genericResponseSignals: genericResponseSignals(item.text),
    callbackShapes: callbackShapes(item.text),
    responseContexts: [
      ...contextsFor(item.text, '.responseText'),
      ...contextsFor(item.text, '.response'),
      ...contextsFor(item.text, 'readyState'),
      ...contextsFor(item.text, 'onreadystatechange'),
      ...contextsFor(item.text, 'onload'),
    ].slice(0, 12),
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_IDENTIFIER_PROVENANCE_AUDIT',
    safety: {
      databaseWrites: false, browserAutomation: false, javascriptExecuted: false,
      xhrExecuted: false, cookiesOrAuthentication: false, antiBotBypass: false,
      rawScriptBodiesStored: false, rawUrlsStored: false, dynamicValuesStored: false,
      contextsSanitized: true,
    },
    response: { status: response.status, contentType: type, bytes: response.body.length, redirects: response.redirects },
    scripts: analyses,
    recommendation: analyses.length ? 'SANITIZED_PROVENANCE_CAPTURED' : 'NO_RELEVANT_SCRIPT_FOUND',
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-nupload-identifier-provenance-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');
  console.log('[NuploadIdentifierProvenanceAudit] Complete');
  console.log('  scripts        : ' + analyses.length);
  console.log('  recommendation : ' + summary.recommendation);
  console.log('  summary        : ' + output);
};

main()
  .catch((error) => {
    console.error('[NuploadIdentifierProvenanceAudit] ' + (error?.code || error.message));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
