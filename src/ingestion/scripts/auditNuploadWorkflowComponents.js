'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } = require('../../modules/streams/http/safeHttpClient');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';
const MAX_HTML_BYTES = 512 * 1024;
const BODY_DEPENDENCIES = ['ty','sesz','t','p','x','zl'];

const extractInlineScripts = (html) => {
  const output = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) output.push(match[1] || '');
  return output;
};

const sanitize = (text) => String(text || '')
  .replace(/https?:\/\/[^\s'"`<>]+/gi, '<url>')
  .replace(/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '<str>')
  .replace(/`(?:\\.|[^`])*`/g, '<template>')
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
  .replace(/\b\d{4,}\b/g, '<num>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 700);

const contextsFor = (text, needle, radius = 220, limit = 6) => {
  const output = []; let offset = 0;
  while (output.length < limit) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    output.push(sanitize(text.slice(Math.max(0,index-radius), Math.min(text.length,index+needle.length+radius))));
    offset = index + needle.length;
  }
  return [...new Set(output)];
};

const declarationShape = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const output = [];
  const patterns = [
    new RegExp('(?:var|let|const)\\s+'+escaped+'\\s*=\\s*([^,;\\r\\n]{1,600})','g'),
    new RegExp('(?:^|[;{}\\r\\n,])\\s*'+escaped+'\\s*=\\s*([^,;\\r\\n]{1,600})','g'),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) output.push(sanitize(match[1]));
  }
  return [...new Set(output)].slice(0,8);
};

const mutationShape = (text, name) => {
  const escaped = name.replace(/[$]/g, '\\$&');
  const operations = [];
  const patterns = [
    ['increment', new RegExp('(?:\\+\\+'+escaped+'|'+escaped+'\\+\\+)','g')],
    ['decrement', new RegExp('(?:--'+escaped+'|'+escaped+'--)','g')],
    ['plus_assign', new RegExp(escaped+'\\s*\\+=','g')],
    ['minus_assign', new RegExp(escaped+'\\s*-=','g')],
    ['direct_assign', new RegExp(escaped+'\\s*=','g')],
  ];
  for (const [kind, pattern] of patterns) {
    const count = [...text.matchAll(pattern)].length;
    if (count) operations.push({kind,count});
  }
  return operations;
};

const extractLoadListenerBody = (text, xhrName) => {
  const escaped = xhrName.replace(/[$]/g, '\\$&');
  const startRegex = new RegExp(escaped + String.raw`\.addEventListener\s*\(\s*(['"])load\1\s*,\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^\)]*)\)\s*\{`, 'g');
  const match = startRegex.exec(text);
  if (!match) return null;
  let depth = 1, quote = null, escapedChar = false;
  let i = startRegex.lastIndex;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escapedChar) { escapedChar = false; continue; }
      if (ch === '\\') { escapedChar = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') { depth -= 1; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  return { params: match[2].split(',').map(v=>v.trim()).filter(Boolean), body: text.slice(startRegex.lastIndex, i) };
};

const loadBodySignals = (body) => {
  if (!body) return null;
  const memberReads = [];
  for (const match of body.matchAll(/(?:this|[A-Za-z_$][\w$]*)\.(responseText|response|status|readyState)\b/g)) {
    memberReads.push(match[1]);
  }
  const methodCalls = [];
  for (const match of body.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) methodCalls.push(match[1]);
  const assignments = [];
  for (const match of body.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]{1,400})/g)) {
    assignments.push({name:match[1], rhs:sanitize(match[2])});
  }
  const urlLikeLiterals = [...body.matchAll(/(['"])(https?:\/\/|\/)[^'"\r\n]{1,1024}\1/g)].length;
  return {
    bytes: Buffer.byteLength(body),
    memberReads: [...new Set(memberReads)],
    methodCalls: [...new Set(methodCalls)].sort(),
    assignments: assignments.slice(0,12),
    containsAtob: /\batob\s*\(/.test(body),
    containsJsonParse: /\bJSON\.parse\s*\(/.test(body),
    containsJwplayer: /\bjwplayer\b/.test(body),
    containsFileKey: /\bfile\s*:/.test(body),
    urlLikeLiteralCount: urlLikeLiterals,
    sanitizedContext: sanitize(body),
  };
};

const decodeLoopShape = (text) => {
  const match = /([A-Za-z_$][\w$]*)\.forEach\s*\(\s*function\s+[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,800}?)\}\s*\)/.exec(text);
  if (!match || !/\batob\s*\(/.test(match[3])) return null;
  return {
    collectionIdentifier: match[1],
    itemParameter: match[2],
    bodyShape: sanitize(match[3]),
    hasDigitStrip: /replace\s*\(\s*\/\\D\/g/.test(match[3]),
    hasParseInt: /parseInt\s*\(/.test(match[3]),
    hasFromCharCode: /String\.fromCharCode\s*\(/.test(match[3]),
  };
};

const loadWatchSample = async () => {
  const { rows } = await pool.query(
    `SELECT scs.iframe_url, sci.tutorial_url
     FROM source_catalog_servers scs
     JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id
     WHERE scs.is_active = TRUE AND sci.fetch_status='ok'
       AND sci.match_status='matched' AND sci.mapped_content_type='movie'
       AND sci.mapped_content_id IS NOT NULL AND scs.iframe_host=$1
       AND scs.iframe_url LIKE 'https://nupload.my/watch/%'
     ORDER BY scs.id ASC LIMIT 1`, [TARGET_HOST]
  );
  return rows[0] || null;
};

const main = async () => {
  const row = await loadWatchSample();
  if (!row) throw new Error('WATCH_SAMPLE_NOT_FOUND');
  const http = createSafeHttpClient({timeoutMs:6000,maxBytes:MAX_HTML_BYTES,maxRedirects:3});
  const response = await http.get(row.iframe_url,{headers:{referer:row.tutorial_url,accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'},timeoutMs:6000,maxBytes:MAX_HTML_BYTES,maxRedirects:3});
  const type=String(response.headers?.['content-type']||'').split(';',1)[0].trim().toLowerCase();
  if(!response.ok||!['text/html','application/xhtml+xml'].includes(type)) throw new Error('WATCH_HTML_NOT_AVAILABLE');
  const scripts=extractInlineScripts(response.body.toString('utf8'));
  const selected=scripts.map((text,index)=>({text,index})).filter(item=>/\.open\s*\(/.test(item.text));
  const analyses=selected.map(item=>{
    const open=/([A-Za-z_$][\w$]*)\.open\s*\(/.exec(item.text);
    const xhrName=open?.[1]||null;
    const load=xhrName?extractLoadListenerBody(item.text,xhrName):null;
    return {
      scriptIndex:item.index,
      dependencies:Object.fromEntries(BODY_DEPENDENCIES.map(name=>[name,{declarations:declarationShape(item.text,name),mutations:mutationShape(item.text,name),contexts:contextsFor(item.text,name,140,3)}])),
      decodeLoop:decodeLoopShape(item.text),
      loadListener:load?{parameters:load.params,...loadBodySignals(load.body)}:null,
      bodyAssemblyContexts:contextsFor(item.text,'o=',240,4),
    };
  });
  const summary={generatedAt:new Date().toISOString(),mode:'READ_ONLY_NUPLOAD_WORKFLOW_COMPONENT_AUDIT',safety:{databaseWrites:false,browserAutomation:false,javascriptExecuted:false,xhrExecuted:false,cookiesOrAuthentication:false,antiBotBypass:false,rawScriptBodiesStored:false,rawUrlsStored:false,dynamicValuesStored:false,contextsSanitized:true},response:{status:response.status,contentType:type,bytes:response.body.length,redirects:response.redirects},scripts:analyses,recommendation:analyses.some(x=>x.loadListener)?'BODY_AND_LOAD_CALLBACK_SHAPES_CAPTURED':'LOAD_CALLBACK_NOT_CAPTURED'};
  fs.mkdirSync(REPORT_DIR,{recursive:true});
  const output=path.join(REPORT_DIR,'tutorial-nupload-workflow-components-summary.json');
  fs.writeFileSync(output,JSON.stringify(summary,null,2),'utf8');
  console.log('[NuploadWorkflowComponentsAudit] Complete');
  console.log('  recommendation : '+summary.recommendation);
  console.log('  summary        : '+output);
};

main().catch(error=>{console.error('[NuploadWorkflowComponentsAudit] '+(error?.code||error.message));process.exitCode=1;}).finally(()=>pool.end().catch(()=>{}));
