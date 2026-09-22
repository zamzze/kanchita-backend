'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveArchitectureFamily, detectArchitectureSignals } = require('./kodiArchitecture');

const CAPABILITIES = Object.freeze([
  'direct_hls', 'direct_http', 'json_api', 'static_html', 'iframe_http',
  'multi_hop_iframe', 'header_bound', 'cookie_session', 'javascript_transform',
  'browser_required', 'anti_bot', 'drm_or_protected', 'unknown',
]);
const RECOMMENDATIONS = Object.freeze({
  implementable_now: Object.freeze(['direct_hls', 'json_api']),
  next_http_layer: Object.freeze(['static_html', 'iframe_http', 'header_bound']),
  future_session_layer: Object.freeze(['cookie_session']),
  legacy_only: Object.freeze(['browser_required', 'anti_bot', 'drm_or_protected']),
});
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 1000;
const safeId = (value) => String(value || '').replace(/\.(?:py|json)$/i, '')
  .toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 128) || 'unknown';

const RULES = Object.freeze([
  ['direct_hls', /\.m3u8|mpegurl|parse_hls|hls/i],
  ['direct_http', /(?:downloadpage|httptools|requests?\.(?:get|post)|urlopen|\.mp4)/i],
  ['json_api', /json\.(?:loads?|decode)|\.json\b|response\.json/i],
  ['static_html', /scrapertools|beautifulsoup|html\.parser|<html|findall/i],
  ['iframe_http', /iframe|embed(?:_url)?/i],
  ['header_bound', /referer|origin|user-agent|request_headers|headers\s*=/i],
  ['cookie_session', /cookiejar|cookies?|set-cookie|session\s*=/i],
  ['javascript_transform', /jsunpack|unpack|packed|javascript|eval\s*\(/i],
  ['browser_required', /selenium|playwright|puppeteer|webdriver|browser/i],
  ['anti_bot', /cloudflare|recaptcha|turnstile|captcha|anti.?bot/i],
  ['drm_or_protected', /widevine|fairplay|playready|drm|license_server/i],
]);
const CHANNEL_RULES = Object.freeze([
  ['api_catalog', /json\.(?:loads?|decode)|response\.json|api\//i],
  ['html_catalog', /scrapertools|beautifulsoup|html\.parser/i],
  ['search_page', /def\s+search|search\(/i],
  ['detail_page', /def\s+(?:findvideos|episodios|peliculas)|detail/i],
  ['server_link_extraction', /servertools|find_video_items|findvideos/i],
  ['pagination', /next_page|pagination|pagina|page=/i],
  ['login_required', /login|password|oauth|authorization/i],
  ['anti_bot', /cloudflare|recaptcha|turnstile|captcha/i],
]);

const confidence = (matches) => matches >= 3 ? 'high' : matches === 2 ? 'medium' : 'low';
const classifyText = (text, kind = 'server') => {
  const rules = kind === 'channel' ? CHANNEL_RULES : RULES;
  const features = [];
  let signals = 0;
  for (const [name, pattern] of rules) {
    const matches = String(text).match(new RegExp(pattern.source, pattern.flags.includes('g')
      ? pattern.flags : `${pattern.flags}g`)) || [];
    if (matches.length) {
      features.push(name);
      signals += Math.min(matches.length, 3);
    }
  }
  if (kind === 'server' && /iframe|embed(?:_url)?/i.test(String(text)) &&
      /servertools\.resolve_video_urls|servertools\.find_video_items/i.test(String(text)) &&
      !features.includes('multi_hop_iframe')) {
    features.push('multi_hop_iframe');
    signals += 2;
  }
  if (!features.length) features.push('unknown');
  return Object.freeze({ classifications: Object.freeze(features),
    confidence: confidence(signals) });
};

const discoverFolders = (root, maximumDepth = 4) => {
  const found = [];
  const visit = (current, depth) => {
    if (depth > maximumDepth || found.length >= 16) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          ['.git', 'images', 'resources', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.name === 'servers' || entry.name === 'channels') found.push(full);
      else visit(full, depth + 1);
    }
  };
  visit(path.resolve(root), 0);
  return found;
};

const scanKodiTaxonomy = ({ roots = [], maxFiles = MAX_FILES,
  maxFileBytes = MAX_FILE_BYTES, architecture = false } = {}) => {
  if (!Array.isArray(roots) || !Number.isInteger(maxFiles) || maxFiles < 1 ||
      maxFiles > MAX_FILES || !Number.isInteger(maxFileBytes) ||
      maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES || typeof architecture !== 'boolean') {
    throw Object.assign(new Error('KODI_TAXONOMY_INVALID_INPUT'),
      { code: 'KODI_TAXONOMY_INVALID_INPUT' });
  }
  const records = [];
  let skipped = 0;
  let filesSeen = 0;
  const folders = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) { skipped += 1; continue; }
    folders.push(...discoverFolders(root));
  }
  folders.sort((left, right) => {
    const leftKind = path.basename(left) === 'servers' ? 0 : 1;
    const rightKind = path.basename(right) === 'servers' ? 0 : 1;
    return leftKind - rightKind || left.localeCompare(right);
  });
  for (const folder of folders) {
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch {
        skipped += 1; continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:py|json)$/i.test(entry.name)) continue;
        filesSeen += 1;
        if (filesSeen > maxFiles) { skipped += 1; continue; }
        const full = path.join(folder, entry.name);
        let stat;
        try { stat = fs.statSync(full); } catch { skipped += 1; continue; }
        if (stat.size > maxFileBytes) { skipped += 1; continue; }
        let text;
        try {
          const raw = fs.readFileSync(full);
          if (raw.includes(0)) { skipped += 1; continue; }
          text = raw.toString('utf8');
        } catch { skipped += 1; continue; }
        const kind = path.basename(folder) === 'channels' ? 'channel' : 'server';
        const classified = classifyText(text, kind);
        let inactive = /(?:['"]active['"]\s*:\s*false|__status__\s*=\s*['"](?:off|disabled))/i
          .test(text);
        const architectureSignals = architecture && kind === 'server'
          ? detectArchitectureSignals(text) : null;
        records.push(Object.freeze({ id: safeId(entry.name), kind, inactive,
          classifications: classified.classifications, confidence: classified.confidence,
          ...(architectureSignals ? {
            architectureFamily: deriveArchitectureFamily({
              classifications: classified.classifications,
              signals: architectureSignals,
            }),
            architectureSignals,
          } : {}),
        }));
      }
  }
  records.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(CAPABILITIES.map((key) => [key, 0]));
  for (const record of records.filter(({ kind }) => kind === 'server')) {
    for (const capability of record.classifications) {
      if (Object.hasOwn(counts, capability)) counts[capability] += 1;
    }
  }
  return Object.freeze({
    servers: Object.freeze({
      total: records.filter(({ kind }) => kind === 'server').length,
      active: records.filter(({ kind, inactive }) => kind === 'server' && !inactive).length,
      ...counts,
    }),
    channels: Object.freeze({ total: records.filter(({ kind }) => kind === 'channel').length }),
    skipped,
    records: Object.freeze(records),
    recommendations: RECOMMENDATIONS,
  });
};

module.exports = {
  CAPABILITIES, MAX_FILE_BYTES, MAX_FILES, classifyText, scanKodiTaxonomy,
};
