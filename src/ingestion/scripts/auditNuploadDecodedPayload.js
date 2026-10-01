'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } =
  require('../../modules/streams/http/safeHttpClient');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ARRAY_SOURCE_BYTES = 128 * 1024;
const MAX_ARRAY_ITEMS = 4096;
const MAX_DECODED_STRING = 16 * 1024;

const extractInlineScripts = (html) => {
  const output = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) output.push(match[1] || '');
  return output;
};

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');

const sanitize = (text) => String(text || '')
  .replace(/https?:\/\/[^\s'"<>]+/gi, '<url>')
  .replace(/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '<str>')
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
  .replace(/\b\d{4,}\b/g, '<num>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 700);

const contextsFor = (text, needle, radius = 180, limit = 8) => {
  const output = [];
  let offset = 0;
  while (output.length < limit) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    output.push(sanitize(text.slice(
      Math.max(0, index - radius),
      Math.min(text.length, index + needle.length + radius)
    )));
    offset = index + needle.length;
  }
  return [...new Set(output)];
};

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
      extension: path.extname(url.pathname).toLowerCase() || null,
    };
  } catch {
    return null;
  }
};

const parseQuotedString = (source, state) => {
  const quote = source[state.index];
  if (quote !== '"' && quote !== "'") return null;
  state.index += 1;
  let output = '';

  while (state.index < source.length) {
    const ch = source[state.index++];
    if (ch === quote) return output;
    if (ch !== '\\') {
      output += ch;
      continue;
    }
    if (state.index >= source.length) return null;
    const escaped = source[state.index++];
    const simple = {
      '\\': '\\',
      '"': '"',
      "'": "'",
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0',
    };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      output += simple[escaped];
      continue;
    }
    if (escaped === 'x') {
      const hex = source.slice(state.index, state.index + 2);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      state.index += 2;
      continue;
    }
    if (escaped === 'u') {
      const hex = source.slice(state.index, state.index + 4);
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      state.index += 4;
      continue;
    }
    output += escaped;
  }
  return null;
};

const parseStringArrayLiteral = (source) => {
  if (typeof source !== 'string' || source.length > MAX_ARRAY_SOURCE_BYTES) return null;
  const state = { index: 0 };
  const skip = () => {
    while (state.index < source.length && /\s/.test(source[state.index])) {
      state.index += 1;
    }
  };

  skip();
  if (source[state.index] !== '[') return null;
  state.index += 1;
  const items = [];

  while (state.index < source.length) {
    skip();
    if (source[state.index] === ']') {
      state.index += 1;
      skip();
      return state.index === source.length ? items : null;
    }
    if (items.length >= MAX_ARRAY_ITEMS) return null;
    const value = parseQuotedString(source, state);
    if (value === null) return null;
    items.push(value);
    skip();
    if (source[state.index] === ',') {
      state.index += 1;
      continue;
    }
    if (source[state.index] === ']') continue;
    return null;
  }
  return null;
};

const findArrayLiteral = (text, identifier) => {
  const escaped = escapeRegex(identifier);
  const declaration = new RegExp(
    '(?:var|let|const)\\s+' + escaped + '\\s*=\\s*\\[',
    'g'
  );
  const match = declaration.exec(text);
  if (!match) return null;
  const open = text.indexOf('[', match.index);
  if (open < 0) return null;

  let index = open + 1;
  let quote = null;
  let escapedChar = false;
  let depth = 1;
  while (index < text.length && index - open <= MAX_ARRAY_SOURCE_BYTES) {
    const ch = text[index];
    if (quote) {
      if (escapedChar) {
        escapedChar = false;
      } else if (ch === '\\') {
        escapedChar = true;
      } else if (ch === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
    index += 1;
  }
  return null;
};

const findDecodeLoop = (text) => {
  const pattern =
    /([A-Za-z_$][\w$]*)\.forEach\s*\(\s*function\s+[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{1,1200}?)\}\s*\)/g;

  for (const match of text.matchAll(pattern)) {
    const body = match[3];
    if (!/\batob\s*\(/.test(body) ||
        !/String\.fromCharCode\s*\(/.test(body) ||
        !/parseInt\s*\(/.test(body)) continue;

    const accumulator =
      /([A-Za-z_$][\w$]*)\s*\+=\s*String\.fromCharCode\s*\(/.exec(body);
    const shift =
      /parseInt\s*\([\s\S]{0,300}?\)\s*-\s*(\d{1,6})\s*\)/.exec(body);
    const digitStrip = /\.replace\s*\(\s*\/\\D\/g\s*,/.test(body);
    if (!accumulator || !shift || !digitStrip) continue;

    return {
      collectionIdentifier: match[1],
      itemParameter: match[2],
      accumulatorIdentifier: accumulator[1],
      subtraction: Number(shift[1]),
    };
  }
  return null;
};

const decodeCollection = (items, subtraction) => {
  if (!Array.isArray(items) || !Number.isInteger(subtraction)) return null;
  let output = '';
  let failures = 0;

  for (const item of items) {
    try {
      const decoded = Buffer.from(item, 'base64').toString('utf8');
      const digits = decoded.replace(/\D/g, '');
      if (!digits) {
        failures += 1;
        continue;
      }
      const numeric = Number.parseInt(digits, 10);
      const code = numeric - subtraction;
      if (!Number.isFinite(code) || code < 0 || code > 0xffff) {
        failures += 1;
        continue;
      }
      output += String.fromCharCode(code);
      if (output.length > MAX_DECODED_STRING) return null;
    } catch {
      failures += 1;
    }
  }

  return {
    output,
    failures,
    successfulItems: items.length - failures,
  };
};

const classifyDecoded = (value) => {
  const printable = [...value].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 ||
      (code >= 32 && code <= 126);
  }).length;
  const ratio = value.length
    ? Number((printable / value.length).toFixed(4))
    : 0;
  const parsedUrl = describeUrl(value.trim());
  const lower = value.toLowerCase();

  return {
    length: value.length,
    sha256Prefix: crypto.createHash('sha256')
      .update(value).digest('hex').slice(0, 12),
    printableRatio: ratio,
    kind: parsedUrl
      ? 'absolute_http_url'
      : lower.includes('.m3u8')
        ? 'text_contains_hls'
        : lower.includes('.mp4')
          ? 'text_contains_mp4'
          : /^[A-Za-z_$][\w$]*$/.test(value.trim())
            ? 'identifier_like'
            : 'other_text',
    url: parsedUrl,
    containsHlsMarker: lower.includes('.m3u8') || lower.includes('#extm3u'),
    containsMp4Marker: lower.includes('.mp4'),
  };
};

const loadWatchSample = async () => {
  const sql =
    'SELECT scs.iframe_url, sci.tutorial_url ' +
    'FROM source_catalog_servers scs ' +
    'JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id ' +
    "WHERE scs.is_active = TRUE AND sci.fetch_status = 'ok' " +
    "AND sci.match_status = 'matched' " +
    "AND sci.mapped_content_type = 'movie' " +
    'AND sci.mapped_content_id IS NOT NULL ' +
    'AND scs.iframe_host = $1 ' +
    "AND scs.iframe_url LIKE 'https://nupload.my/watch/%' " +
    'ORDER BY scs.id ASC LIMIT 1';

  const { rows } = await pool.query(sql, [TARGET_HOST]);
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
  if (!response.ok ||
      !['text/html', 'application/xhtml+xml'].includes(type)) {
    throw new Error('WATCH_HTML_NOT_AVAILABLE');
  }

  const scripts = extractInlineScripts(response.body.toString('utf8'));
  let analysis = null;

  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index];
    const loop = findDecodeLoop(script);
    if (!loop) continue;

    const literal = findArrayLiteral(script, loop.collectionIdentifier);
    const items = literal ? parseStringArrayLiteral(literal) : null;
    const decoded = items ? decodeCollection(items, loop.subtraction) : null;

    analysis = {
      scriptIndex: index,
      scriptBytes: Buffer.byteLength(script),
      decodeLoop: {
        collectionIdentifierKind: 'local_identifier',
        accumulatorIdentifierKind: 'local_identifier',
        itemParameterKind: 'function_parameter',
        subtraction: loop.subtraction,
        digitStrip: true,
        collectionLiteralFound: Boolean(literal),
        collectionItems: items?.length ?? null,
      },
      decodeResult: decoded ? {
        failures: decoded.failures,
        successfulItems: decoded.successfulItems,
        classification: classifyDecoded(decoded.output),
      } : null,
      accumulatorUsage: contextsFor(script, loop.accumulatorIdentifier),
      collectionUsageCount:
        contextsFor(script, loop.collectionIdentifier, 120, 32).length,
      recommendation: decoded
        ? 'STATIC_DECODE_SUCCEEDED'
        : literal
          ? 'STATIC_DECODE_FAILED'
          : 'COLLECTION_LITERAL_NOT_FOUND',
    };
    break;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_DECODED_PAYLOAD_AUDIT',
    safety: {
      databaseWrites: false,
      browserAutomation: false,
      javascriptExecuted: false,
      xhrExecuted: false,
      cookiesOrAuthentication: false,
      antiBotBypass: false,
      decodedRawValueStored: false,
      rawScriptBodiesStored: false,
      rawUrlsStored: false,
    },
    response: {
      status: response.status,
      contentType: type,
      bytes: response.body.length,
      redirects: response.redirects,
    },
    analysis,
    recommendation:
      analysis?.recommendation || 'DECODE_LOOP_NOT_FOUND',
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(
    REPORT_DIR,
    'tutorial-nupload-decoded-payload-summary.json'
  );
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[NuploadDecodedPayloadAudit] Complete');
  console.log('  recommendation : ' + summary.recommendation);
  if (analysis?.decodeResult?.classification) {
    const classification = analysis.decodeResult.classification;
    console.log('  decoded kind   : ' + classification.kind);
    console.log('  hls marker     : ' + classification.containsHlsMarker);
    console.log('  mp4 marker     : ' + classification.containsMp4Marker);
  }
  console.log('  summary        : ' + output);
};

main()
  .catch((error) => {
    console.error(
      '[NuploadDecodedPayloadAudit] ' + (error?.code || error.message)
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
