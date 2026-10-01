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

const safeName = (value) =>
  typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value) ? value : null;

const describeExpression = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'empty' };
  if (/^null$/.test(text)) return { kind: 'null' };
  if (/^(?:true|false)$/.test(text)) return { kind: 'boolean_literal' };
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { kind: 'number_literal' };
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return { kind: 'identifier', name: text };
  }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(text)) {
    return { kind: 'member_expression', path: text.split('.').slice(1) };
  }
  if (/^JSON\.stringify\s*\(/.test(text)) return { kind: 'json_stringify' };
  if (/^JSON\.parse\s*\(/.test(text)) return { kind: 'json_parse' };
  if (/^(?:new\s+)?URLSearchParams\s*\(/.test(text)) {
    return { kind: 'url_search_params' };
  }
  if (/^(?:new\s+)?FormData\s*\(/.test(text)) return { kind: 'form_data' };
  if (/\batob\s*\(/.test(text)) return { kind: 'atob_call' };
  if (/\.responseText\b/.test(text)) return { kind: 'response_text_expression' };
  if (/\.response\b/.test(text)) return { kind: 'response_expression' };
  if (/\.split\s*\(/.test(text)) return { kind: 'split_expression' };
  if (/\.replace\s*\(/.test(text)) return { kind: 'replace_expression' };
  if (/\.match\s*\(/.test(text)) return { kind: 'match_expression' };
  if (/`/.test(text)) return { kind: 'template_expression' };
  if (/\+/.test(text)) return { kind: 'concatenation' };
  const literal = /^(['"])([\s\S]*)\1$/.exec(text);
  if (literal) return { kind: 'string_literal', length: literal[2].length };
  return { kind: 'other' };
};

const objectKeysFromExpression = (raw) => {
  const text = String(raw || '');
  const match = /\{([\s\S]*?)\}/.exec(text);
  if (!match) return [];
  const keys = new Set();
  const pattern = /(?:^|[,\s])([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:/g;
  for (const item of match[1].matchAll(pattern)) {
    keys.add(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return [...keys].sort();
};

const encodedFieldNamesFromExpression = (raw) => {
  const text = String(raw || '');
  const names = new Set();
  for (const match of text.matchAll(/['"]([A-Za-z0-9_.-]{1,64})=/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/[?&]([A-Za-z0-9_.-]{1,64})=/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
};

const findAssignments = (text, name) => {
  if (!safeName(name)) return [];
  const escaped = name.replace(/[$]/g, '\\$&');
  const patterns = [
    new RegExp('(?:var|let|const)\\s+' + escaped + '\\s*=\\s*([^;\\r\\n]{1,2000})', 'g'),
    new RegExp('(?:^|[;{}\\r\\n])\\s*' + escaped + '\\s*=\\s*([^;\\r\\n]{1,2000})', 'g'),
  ];
  const output = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const expr = match[1].trim();
      if (seen.has(expr)) continue;
      seen.add(expr);
      output.push({
        expression: describeExpression(expr),
        objectKeys: objectKeysFromExpression(expr),
        encodedFieldNames: encodedFieldNamesFromExpression(expr),
      });
    }
  }
  return output.slice(0, 8);
};

const findHeaderShapes = (text, xhrName) => {
  if (!safeName(xhrName)) return [];
  const escaped = xhrName.replace(/[$]/g, '\\$&');
  const regex = new RegExp(
    escaped + '\\.setRequestHeader\\s*\\(\\s*([\\'\"])([^\\'\"\\r\\n]{1,128})\\1\\s*,\\s*([^\\)\\r\\n]{1,512})',
    'g'
  );
  const output = [];
  for (const match of text.matchAll(regex)) {
    const value = match[3].trim();
    const literal = /^(['"])([^'"]{0,256})\1$/.exec(value);
    output.push({
      name: match[2].trim().toLowerCase(),
      valueKind: literal ? 'literal' : describeExpression(value).kind,
      literalValue: literal ? literal[2].toLowerCase() : null,
    });
  }
  return output;
};

const findEventShapes = (text, xhrName) => {
  if (!safeName(xhrName)) return [];
  const escaped = xhrName.replace(/[$]/g, '\\$&');
  const events = new Set();
  const add = new RegExp(
    escaped + '\\.addEventListener\\s*\\(\\s*([\\'\"])([A-Za-z0-9_-]{1,32})\\1',
    'g'
  );
  for (const match of text.matchAll(add)) events.add(match[2].toLowerCase());
  const prop = new RegExp(escaped + '\\.(on[a-z]+)\\s*=', 'gi');
  for (const match of text.matchAll(prop)) events.add(match[1].toLowerCase());
  return [...events].sort();
};

const findResponseType = (text, xhrName) => {
  if (!safeName(xhrName)) return null;
  const escaped = xhrName.replace(/[$]/g, '\\$&');
  const regex = new RegExp(
    escaped + '\\.responseType\\s*=\\s*([\\'\"])([^\\'\"\\r\\n]{0,64})\\1',
    'i'
  );
  const match = regex.exec(text);
  return match ? match[2].toLowerCase() : null;
};

const findOpenCall = (text) => {
  const regex = /([A-Za-z_$][\w$]*)\.open\s*\(\s*(['"])(GET|POST)\2\s*,\s*([^,\r\n\)]+)(?:\s*,\s*([^\)\r\n]+))?/gi;
  const match = regex.exec(text);
  if (!match) return null;
  return {
    xhrName: match[1],
    method: match[3].toUpperCase(),
    endpointExpression: describeExpression(match[4]),
    asyncArgument: match[5] ? describeExpression(match[5]) : { kind: 'default_true' },
  };
};

const findSend = (text, xhrName) => {
  if (!safeName(xhrName)) return null;
  const escaped = xhrName.replace(/[$]/g, '\\$&');
  const regex = new RegExp(escaped + '\\.send\\s*\\(\\s*([^\\)\\r\\n]*)', 'i');
  const match = regex.exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  return {
    argument: describeExpression(raw),
    rawIdentifier: safeName(raw),
  };
};

const findAtob = (text) => {
  const regex = /\batob\s*\(\s*([^\)\r\n]+)/i;
  const match = regex.exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  return { argument: describeExpression(raw), rawIdentifier: safeName(raw) };
};

const methodCallsOn = (text, name) => {
  if (!safeName(name)) return [];
  const escaped = name.replace(/[$]/g, '\\$&');
  const regex = new RegExp(
    escaped + '\\.(split|replace|match|substring|substr|slice|trim|toString)\\s*\\(',
    'g'
  );
  return [...new Set([...text.matchAll(regex)].map((match) => match[1]))].sort();
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
  const relevant = scripts
    .map((text, index) => ({ text, index, open: findOpenCall(text), atob: findAtob(text) }))
    .filter((item) => item.open || item.atob);

  const analysis = relevant.map((item) => {
    const xhrName = item.open?.xhrName || null;
    const send = xhrName ? findSend(item.text, xhrName) : null;
    const bodyName = send?.rawIdentifier || null;
    const valueName = item.atob?.rawIdentifier || null;
    return {
      scriptIndex: item.index,
      bytes: Buffer.byteLength(item.text),
      xhr: item.open ? {
        nameKind: 'local_identifier',
        method: item.open.method,
        endpointExpression: item.open.endpointExpression,
        asyncArgument: item.open.asyncArgument,
        responseType: findResponseType(item.text, xhrName),
        events: findEventShapes(item.text, xhrName),
        headers: findHeaderShapes(item.text, xhrName),
      } : null,
      requestBody: send ? {
        argument: send.argument,
        assignments: bodyName ? findAssignments(item.text, bodyName) : [],
        methodsCalled: bodyName ? methodCallsOn(item.text, bodyName) : [],
      } : null,
      decodedValue: item.atob ? {
        argument: item.atob.argument,
        assignments: valueName ? findAssignments(item.text, valueName) : [],
        methodsCalledBeforeOrAfter: valueName ? methodCallsOn(item.text, valueName) : [],
      } : null,
      responseAccess: {
        responseText: xhrName ? new RegExp(xhrName.replace(/[$]/g, '\\$&') + '\\.responseText\\b').test(item.text) : false,
        response: xhrName ? new RegExp(xhrName.replace(/[$]/g, '\\$&') + '\\.response\\b').test(item.text) : false,
        status: xhrName ? new RegExp(xhrName.replace(/[$]/g, '\\$&') + '\\.status\\b').test(item.text) : false,
      },
    };
  });

  const first = analysis[0] || null;
  const recommendation = !first
    ? 'DATAFLOW_NOT_IDENTIFIED'
    : first.requestBody?.assignments?.length && first.decodedValue?.assignments?.length
      ? 'REQUEST_AND_RESPONSE_DATAFLOW_IDENTIFIED'
      : first.requestBody?.assignments?.length
        ? 'REQUEST_BODY_IDENTIFIED_RESPONSE_VALUE_NEEDS_ONE_MORE_PASS'
        : 'DATAFLOW_PARTIAL_REVIEW_REQUIRED';

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_XHR_DATAFLOW_AUDIT',
    safety: {
      databaseWrites: false,
      browserAutomation: false,
      javascriptExecuted: false,
      xhrExecuted: false,
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
    scripts: analysis,
    recommendation,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-nupload-xhr-dataflow-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[NuploadXhrDataflowAudit] Complete');
  console.log('  relevant scripts : ' + analysis.length);
  console.log('  recommendation   : ' + recommendation);
  console.log('  summary          : ' + output);
};

main()
  .catch((error) => {
    console.error('[NuploadXhrDataflowAudit] ' + (error?.code || error.message));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
