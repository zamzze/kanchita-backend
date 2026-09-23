'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classifyText } = require('./kodiTaxonomyScanner');
const { detectArchitectureSignals, deriveArchitectureFamily } = require('./kodiArchitecture');

const STATUSES = Object.freeze(['AUTO_CONVERTIBLE', 'CONFIG_WITH_CURRENT_RUNTIME',
  'NEEDS_GENERIC_CAPABILITY', 'MANUAL_REVIEW', 'UNSUPPORTED']);
const FAMILIES = Object.freeze(['DIRECT_MEDIA', 'HTTP_REDIRECT', 'HTML_EMBED', 'JSON_API',
  'AJAX_POST', 'MULTI_STEP_HTTP', 'ARRAY_CATALOG', 'SEASON_EPISODE_API',
  'SERVER_DELEGATION', 'UNKNOWN']);
const RUNTIME = Object.freeze(['get_post', 'json_scalar_path', 'html_selector',
  'literal_response_body_capture', 'mapped_http_workflow', 'exact_mapping',
  'bounded_redirects', 'hls_resolver', 'playback_headers', 'multi_hop', 'catalog_runtime']);
const PAYOFF = Object.freeze(['array_iteration', 'multi_value_extract',
  'scalar_capture_chaining', 'repeated_capture', 'safe_regex_single_capture', 'direct_mp4']);
const sorted = (values) => [...new Set(values)].sort();
const is = (text, pattern) => pattern.test(text);

const SIGNALS = Object.freeze([
  ['http.get', /httptools\.downloadpage|requests?\.get\s*\(|urlopen\s*\(/i],
  ['http.post', /requests?\.post\s*\(|downloadpage[^\r\n]{0,200}\bpost\s*=|\bpost\s*=\s*\{/i],
  ['response.json', /jsontools\.(?:load|loads)|json\.(?:load|loads|decode)|response\.json|\.json\b/i],
  ['response.html', /scrapertools|beautifulsoup|html\.parser|<iframe|<html/i],
  ['response.redirect', /allow_redirects|follow_redirect|headers?\[['"]location/i],
  ['extract.iframe', /iframe|embed(?:_url)?/i],
  ['extract.selector', /beautifulsoup|select_one|\.select\(|scrapertools\.get_match/i],
  ['extract.regex', /\bre\.(?:search|findall|finditer|compile|match)\s*\(|scrapertools\.find_(?:single|multiple)_match/i],
  ['extract.literal', /\.split\s*\(\s*['"][^'"]{1,128}['"]\s*\)\s*\[/i],
  ['data.list', /\[['"](?:list|items|results|videos|episodes)['"]\]/i],
  ['data.array_loop', /\bfor\s+\w+\s+in\s+(?:data|response|json|videos|items|episodes)[^:\r\n]{0,100}:/i],
  ['identity.item_id', /\b(?:video|movie|episode|post|item)_?id\b|data[-_]id/i],
  ['identity.tmdb', /\btmdb(?:_id)?\b/i],
  ['identity.imdb', /\bimdb(?:_id)?\b/i],
  ['identity.slug', /\bslug\b/i],
  ['identity.title', /\b(?:title|titulo|nombre)\b/i],
  ['identity.season_episode', /season|temporada|episode|episodio|capitulo/i],
  ['delegate.servertools', /servertools\.(?:resolve_video_urls|find_video_items|get_server_from_url)/i],
  ['media.hls', /\.m3u8|mpegurl/i],
  ['media.mp4', /\.mp4\b|video\/mp4/i],
  ['headers.playback', /referer|origin|user-agent/i],
  ['block.session', /cookiejar|set-cookie|requests?\.session|cookies?\s*=/i],
  ['block.javascript', /jsunpack|execjs|eval\s*\(|deobfuscat|packed\s*\(|\bexec\s*\(|marshal\.loads|base64\.b64decode/i],
  ['block.browser', /selenium|playwright|puppeteer|webdriver/i],
  ['block.antibot', /cloudflare|recaptcha|turnstile|captcha/i],
  ['block.proxy_geo', /\b(?:proxy|geoblock|geo.?bypass|vpn)\b/i],
  ['block.protected', /widevine|fairplay|playready|\bdrm\b|license_server/i],
  ['block.manifest_synthesis', /#EXTM3U[\s\S]{0,3000}#EXTINF|#EXT-X-BYTERANGE/i],
  ['block.dynamic_regex', /re\.compile\s*\(\s*(?:[a-z_]\w*|[^'"\s])/i],
  ['block.external_helper', /m3u8server\.Client|platformtools\.is_playing/i],
]);

const describe = (kind, id, files) => {
  const source = files.map(({ text }) => text).join('\n');
  const python = files.filter(({ name }) => name.endsWith('.py'))
    .map(({ text }) => text).join('\n');
  const signals = new Set(SIGNALS.filter(([, pattern]) => is(source, pattern))
    .map(([name]) => name));
  const yes = (name) => signals.has(name);
  const array = yes('data.array_loop') && yes('data.list');
  // A playlist ID followed by /videos does not establish exact video retrieval.
  const exact = is(python,
    /\/(?:video|videos|item|items|movie|movies|episode|episodes)\/(?:%s|%d|\{(?:external|video|item|movie|episode)[^}]*id\})(?:['"?\s]|$)/i);
  if (exact) signals.add('identity.exact_item_endpoint');
  const classes = classifyText(source, kind).classifications;
  const arch = deriveArchitectureFamily({ classifications: classes,
    signals: detectArchitectureSignals(source) });
  const methods = sorted([yes('http.get') ? 'GET' : null,
    yes('http.post') ? 'POST' : null].filter(Boolean));
  const responseTypes = sorted([yes('response.json') ? 'JSON' : null,
    yes('response.html') ? 'HTML' : null, yes('media.hls') ? 'HLS' : null,
    yes('media.mp4') ? 'MP4' : null].filter(Boolean));
  const extractors = sorted([yes('response.json') ? array ? 'JSON_ARRAY' : 'JSON_SCALAR' : null,
    yes('extract.selector') ? 'HTML_SELECTOR' : null,
    yes('extract.regex') ? 'REGEX' : null,
    yes('extract.literal') ? 'LITERAL' : null].filter(Boolean));
  const required = new Set();
  if (methods.length) required.add('get_post');
  if (yes('response.json')) required.add('json_scalar_path');
  if (yes('extract.selector')) required.add('html_selector');
  if (yes('extract.literal')) required.add('literal_response_body_capture');
  if (yes('response.redirect')) required.add('bounded_redirects');
  if (yes('media.hls')) required.add('hls_resolver');
  if (yes('headers.playback')) required.add('playback_headers');
  if (array) required.add('array_iteration');
  if (is(source, /find_multiple_matches|re\.findall\s*\(/i)) required.add('multi_value_extract');
  if (is(source, /finditer\s*\(|\bfor\s+\w+\s+in\s+re\.findall/i)) required.add('repeated_capture');
  if (is(source, /re\.search\s*\([^\r\n]{0,160}(?:item|match|value|url)/i)) {
    required.add('scalar_capture_chaining');
  }
  if (yes('extract.regex') && !required.has('scalar_capture_chaining') &&
      !required.has('multi_value_extract')) required.add('safe_regex_single_capture');
  if (yes('media.mp4')) required.add('direct_mp4');
  if (exact && kind === 'channel') required.add('exact_mapping');
  const blockers = sorted([...signals].filter((name) => name.startsWith('block.'))
    .map((name) => name.slice(6)));
  const supported = sorted([...required].filter((name) => RUNTIME.includes(name)));
  const missing = sorted([...required].filter((name) => !RUNTIME.includes(name)));
  const family = kind === 'channel' && yes('delegate.servertools') ? 'SERVER_DELEGATION'
    : kind === 'channel' && array ? 'ARRAY_CATALOG'
      : yes('identity.season_episode') && yes('response.json') ? 'SEASON_EPISODE_API'
        : yes('http.post') && yes('response.html') ? 'AJAX_POST'
          : methods.length > 1 ? 'MULTI_STEP_HTTP'
            : yes('response.redirect') ? 'HTTP_REDIRECT'
              : yes('response.json') ? 'JSON_API'
                : yes('extract.iframe') ? 'HTML_EMBED'
                  : yes('media.hls') || yes('media.mp4') || arch === 'DIRECT_MEDIA'
                    ? 'DIRECT_MEDIA' : 'UNKNOWN';
  const jsonOnly = files.every((file) => file.name.endsWith('.json'));
  const stub = files.every((file) => file.name.endsWith('.json') ||
    file.text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line)).length <= 1) &&
    !files.some((file) => file.name.endsWith('.json') && file.text.trim().length > 80);
  const status = stub || jsonOnly ? 'MANUAL_REVIEW' : blockers.length ? 'UNSUPPORTED'
    : kind === 'channel' && !exact ? 'MANUAL_REVIEW'
      : missing.length ? 'NEEDS_GENERIC_CAPABILITY'
        : family === 'UNKNOWN' ? 'MANUAL_REVIEW' : 'CONFIG_WITH_CURRENT_RUNTIME';
  return Object.freeze({ id, kind, files: files.map(({ name }) => name).sort(),
    observedFlow: kind === 'channel' ? array ? 'LIST_DISCOVERY -> EMBED_OR_MEDIA'
      : exact ? 'EXACT_ITEM -> EMBED_OR_MEDIA' : 'UNPROVEN_IDENTITY -> EMBED_OR_MEDIA'
      : 'EMBED_URL -> SERVER_RESOLUTION -> STREAM_CANDIDATE',
    inputs: sorted([kind === 'server' ? 'embed_url' : exact ? 'external_id'
      : array ? 'catalog_page' : 'unknown',
    ...(yes('identity.season_episode') ? ['season', 'episode'] : [])]),
    outputs: kind === 'server' ? ['stream_candidate'] : yes('extract.iframe') ||
      yes('delegate.servertools') ? ['embed_candidate'] : ['unknown'],
    requestMethods: methods, responseTypes, extractors,
    identitySignals: sorted([...signals].filter((name) => name.startsWith('identity.'))
      .map((name) => name.slice(9))),
    seasonEpisodeSupport: yes('identity.season_episode'),
    serverDelegation: yes('delegate.servertools'), redirects: yes('response.redirect'),
    directMedia: { hls: yes('media.hls'), mp4: yes('media.mp4') },
    requiredCapabilities: sorted(required), supportedCapabilities: supported,
    missingCapabilities: missing, excludedBlockers: blockers,
    migrationStatus: status, migrationFamily: family, evidence: sorted(signals) });
};

const calculatePayoff = (records) => PAYOFF.map((capability) => {
  const affected = records.filter((item) => item.missingCapabilities.includes(capability));
  const full = affected.filter((item) => item.migrationStatus === 'NEEDS_GENERIC_CAPABILITY' &&
    !item.excludedBlockers.length && item.missingCapabilities.every((name) => name === capability));
  return { capability, affectedModules: affected.length, fullUnlockDelta: full.length,
    partialReductionDelta: affected.length - full.length };
}).sort((a, b) => b.fullUnlockDelta - a.fullUnlockDelta ||
  b.affectedModules - a.affectedModules || a.capability.localeCompare(b.capability));

const summarize = (records) => {
  const byKind = { channel: 0, server: 0 };
  const byMigrationStatus = Object.fromEntries(STATUSES.map((key) => [key, 0]));
  const byMigrationFamily = Object.fromEntries(FAMILIES.map((key) => [key, 0]));
  const gaps = new Map();
  for (const item of records) {
    byKind[item.kind] += 1;
    byMigrationStatus[item.migrationStatus] += 1;
    byMigrationFamily[item.migrationFamily] += 1;
    for (const capability of item.missingCapabilities) {
      gaps.set(capability, (gaps.get(capability) || 0) + 1);
    }
  }
  const ids = (status) => records.filter((item) => item.migrationStatus === status)
    .map((item) => `${item.kind}:${item.id}`);
  return { totalUniqueModules: records.length, byKind, byMigrationStatus,
    byMigrationFamily, topMissingCapabilities: [...gaps].map(([capability, affectedModules]) =>
      ({ capability, affectedModules })).sort((a, b) => b.affectedModules - a.affectedModules ||
      a.capability.localeCompare(b.capability)), autoConvertibleIds: ids('AUTO_CONVERTIBLE'),
    configWithCurrentRuntimeIds: ids('CONFIG_WITH_CURRENT_RUNTIME'),
    needsGenericCapabilityIds: ids('NEEDS_GENERIC_CAPABILITY'), payoff: calculatePayoff(records) };
};

const createManifest = (files) => {
  if (!Array.isArray(files)) throw new Error('MIGRATION_MANIFEST_INVALID_INPUT');
  const groups = new Map();
  for (const file of files.slice(0, 1000)) {
    if (!file || !['channel', 'server'].includes(file.kind) ||
        typeof file.name !== 'string' || !/^[a-z0-9_-]+\.(?:py|json)$/i.test(file.name) ||
        typeof file.text !== 'string' || Buffer.byteLength(file.text) > 1024 * 1024) continue;
    const id = file.name.replace(/\.(?:py|json)$/i, '').toLowerCase();
    const key = `${file.kind}:${id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: `${file.kind === 'channel' ? 'channels' : 'servers'}/${file.name}`,
      text: file.text });
  }
  const manifest = [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => describe(key.split(':')[0], key.split(':')[1], group));
  return { manifest, summary: summarize(manifest) };
};

const scanProviderMigrationManifest = ({ root } = {}) => {
  if (typeof root !== 'string' || !root) throw new Error('MIGRATION_MANIFEST_INVALID_ROOT');
  const files = [];
  for (const [folder, kind] of [['channels', 'channel'], ['servers', 'server']]) {
    const entries = fs.readdirSync(path.join(path.resolve(root), folder), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:py|json)$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= 1000) break;
      const full = path.join(path.resolve(root), folder, entry.name);
      if (fs.statSync(full).size > 1024 * 1024) continue;
      const raw = fs.readFileSync(full);
      if (!raw.includes(0)) files.push({ kind, name: entry.name, text: raw.toString('utf8') });
    }
  }
  return createManifest(files);
};

module.exports = { FAMILIES, RUNTIME, STATUSES, PAYOFF,
  createManifest, calculatePayoff, scanProviderMigrationManifest, summarize };
