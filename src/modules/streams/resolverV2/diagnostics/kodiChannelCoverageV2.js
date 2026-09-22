'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RUNTIME_COMMIT, createKanchitaCapabilityProfile } =
  require('./kodiArchitectureCoverageV2');

const CHANNEL_PATTERNS = Object.freeze([
  'JSON_API_CATALOG',
  'HTML_CATALOG',
  'HTML_SERIES_TREE',
  'HTML_AJAX_WORKFLOW',
  'HTTP_API_WORKFLOW',
  'MULTI_STEP_HTTP_WORKFLOW',
  'MAPPED_EXACT_ITEM',
  'JAVASCRIPT_TRANSFORM',
  'SESSION_HTTP',
  'MONOLITHIC_LEGACY',
  'UNKNOWN',
]);
const CHANNEL_ASSESSMENTS = Object.freeze([
  'MAPPABLE_WITH_CURRENT_COMPONENTS',
  'NEEDS_SMALL_GENERIC_COMPONENT',
  'UNSUPPORTED_JAVASCRIPT',
  'UNSUPPORTED_SESSION',
  'UNSUPPORTED_BROWSER',
  'UNSUPPORTED_MANIFEST',
  'UNKNOWN',
]);
const MAX_CHANNEL_FILES = 128;
const MAX_CHANNEL_BYTES = 1024 * 1024;

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const matches = (text, pattern) => pattern.test(String(text));
const occurrences = (text, pattern) => (String(text).match(pattern) || []).length;
const safeId = (filename) => filename.replace(/\.py$/i, '').toLowerCase()
  .replace(/[^a-z0-9_-]/g, '_').slice(0, 128) || 'unknown';

const detectChannelSignals = (text) => {
  const source = String(text);
  const identitySignals = [];
  if (matches(source, /data[-_]id|data-id/i)) identitySignals.push('data_id');
  if (matches(source, /\b(?:item|post|video|episode|movie)_?id\b/i)) identitySignals.push('item_id');
  if (matches(source, /\bslug\b/i)) identitySignals.push('slug');
  if (matches(source, /\btmdb(?:_id)?\b/i)) identitySignals.push('tmdb');
  if (matches(source, /\bimdb(?:_id)?\b/i)) identitySignals.push('imdb');
  if (matches(source, /urlparse|urlsplit|\.path\b/i)) identitySignals.push('url_path');

  const catalogSignals = [];
  const json = matches(source, /json\.(?:load|loads|decode)|response\.json|\/api\//i);
  const html = matches(source, /scrapertools|beautifulsoup|html\.parser|findall|<article|<li/i);
  const ajax = matches(source, /\bajax\b|x-requested-with|admin-ajax/i);
  if (json) catalogSignals.push('json_api');
  if (html) catalogSignals.push('html');
  if (ajax) catalogSignals.push('ajax');
  if (matches(source, /next_page|pagination|load_more|page\s*=|pagina/i)) {
    catalogSignals.push('pagination');
  }
  if (matches(source, /def\s+search|\bsearch(?:_url)?\b/i)) catalogSignals.push('search');

  const episodeSignals = [];
  if (matches(source, /season|temporada/i)) episodeSignals.push('season_tree');
  if (matches(source, /episode|episodio|capitulo/i)) episodeSignals.push('episodes');
  if (ajax && episodeSignals.length) episodeSignals.push('ajax_episode');
  if (matches(source, /\/seasons?\b|seasons?_url/i)) episodeSignals.push('seasons_endpoint');
  if (matches(source, /\/episodes?\b|episodes?_url/i)) episodeSignals.push('episodes_endpoint');

  const sourceSignals = [];
  if (matches(source, /iframe|embed(?:_url)?/i)) sourceSignals.push('iframe_embed');
  if (matches(source, /player(?:_options|options|_id)|data-player/i)) {
    sourceSignals.push('player_options');
  }
  if (matches(source, /servertools\.(?:find_video_items|resolve_video_urls|get_server_from_url)/i)) {
    sourceSignals.push('server_delegation');
  }
  const httpCalls = occurrences(source,
    /httptools\.downloadpage|requests?\.(?:get|post)\s*\(|(?:urllib(?:2)?\.)?urlopen\s*\(/gi);
  const post = matches(source,
    /requests?\.post\s*\(|httptools\.downloadpage[^\r\n]{0,240}\bpost\s*=|\bpost\s*=\s*\{/i);
  if (httpCalls > 1) sourceSignals.push('multi_step_http');
  if (post) sourceSignals.push('http_post');
  if (matches(source, /\.m3u8(?:\?|['"\s]|$)|mpegurl/i)) sourceSignals.push('direct_hls');
  if (matches(source, /\.mp4(?:\?|['"\s]|$)|video\/mp4/i)) sourceSignals.push('direct_mp4');

  const blockerSignals = [];
  if (matches(source, /cookiejar|set-cookie|\bcookies?\s*=|requests?\.session/i)) {
    blockerSignals.push('persistent_session');
  }
  if (matches(source, /jsunpack|javascript|eval\s*\(|execjs|deobfuscat|packed/i)) {
    blockerSignals.push('javascript_transform');
  }
  if (matches(source, /selenium|playwright|puppeteer|webdriver|cloudflare|captcha|recaptcha|turnstile/i)) {
    blockerSignals.push('browser_or_antibot');
  }
  if (matches(source, /#EXTM3U/i) && matches(source, /#EXTINF|#EXT-X-BYTERANGE|\.m3u8[^\r\n]{0,100}(?:write|save)/i)) {
    blockerSignals.push('manifest_synthesis');
  }
  const regexCalls = occurrences(source,
    /\bre\.(?:compile|findall|finditer|match|search|sub)\s*\(|scrapertools\.(?:find_multiple_matches|find_single_match)/gi);
  if (regexCalls >= 3) blockerSignals.push('regex_heavy_transform');
  if (json && matches(source, /for\s+\w+\s+in\s+(?:data|items|results|response|json)/i)) {
    blockerSignals.push('array_iteration');
  }
  if (matches(source, /\bproxy\b|x-forwarded-for|geo(?:block|location)/i)) {
    blockerSignals.push('proxy_or_geo');
  }

  return freeze({ identitySignals: [...new Set(identitySignals)].sort(),
    catalogSignals: [...new Set(catalogSignals)].sort(),
    episodeSignals: [...new Set(episodeSignals)].sort(),
    sourceSignals: [...new Set(sourceSignals)].sort(),
    blockerSignals: [...new Set(blockerSignals)].sort(), httpCalls, regexCalls });
};

const deriveChannelPattern = (signals) => {
  const blockers = new Set(signals.blockerSignals);
  const catalog = new Set(signals.catalogSignals);
  const episodes = new Set(signals.episodeSignals);
  const sources = new Set(signals.sourceSignals);
  if (blockers.has('javascript_transform')) return 'JAVASCRIPT_TRANSFORM';
  if (blockers.has('persistent_session')) return 'SESSION_HTTP';
  if (catalog.has('json_api') && (sources.has('multi_step_http') || sources.has('http_post'))) {
    return 'HTTP_API_WORKFLOW';
  }
  if (catalog.has('json_api')) return 'JSON_API_CATALOG';
  if (catalog.has('ajax') && episodes.size > 0) return 'HTML_AJAX_WORKFLOW';
  if (episodes.has('season_tree') && episodes.has('episodes')) return 'HTML_SERIES_TREE';
  if (sources.has('multi_step_http') || sources.has('http_post')) {
    return 'MULTI_STEP_HTTP_WORKFLOW';
  }
  if (catalog.has('html')) return 'HTML_CATALOG';
  if (signals.httpCalls > 0 &&
      (sources.has('direct_hls') || sources.has('direct_mp4'))) return 'MAPPED_EXACT_ITEM';
  if (signals.identitySignals.length > 0 && signals.httpCalls > 0) return 'MAPPED_EXACT_ITEM';
  if (signals.regexCalls > 0 || sources.has('server_delegation')) return 'MONOLITHIC_LEGACY';
  return 'UNKNOWN';
};

const requiredCapabilities = (signals, pattern) => {
  const required = new Set();
  const catalog = new Set(signals.catalogSignals);
  const sources = new Set(signals.sourceSignals);
  const blockers = new Set(signals.blockerSignals);
  if (signals.httpCalls > 0 || pattern !== 'UNKNOWN') required.add('http_get');
  if (signals.identitySignals.length > 0) required.add('mapped_identity');
  if (catalog.has('html')) required.add('html_extract');
  if (catalog.has('json_api')) required.add('json_scalar_extract');
  if (sources.has('http_post')) required.add('http_post');
  if (sources.has('multi_step_http')) required.add('linear_workflow');
  if (sources.has('iframe_embed')) required.add('relative_url_resolution');
  if (sources.has('direct_hls')) required.add('hls');
  if (sources.has('direct_mp4')) required.add('direct_mp4');
  if (blockers.has('persistent_session')) required.add('persistent_session');
  if (blockers.has('javascript_transform')) required.add('javascript_transform');
  if (blockers.has('browser_or_antibot')) required.add('browser_automation');
  if (blockers.has('manifest_synthesis')) required.add('manifest_synthesis');
  if (blockers.has('regex_heavy_transform')) required.add('html_regex_transform');
  if (blockers.has('array_iteration')) required.add('array_iteration');
  if (blockers.has('proxy_or_geo')) required.add('proxy_or_geo');
  if (pattern === 'UNKNOWN') required.add('unknown_pattern');
  return Object.freeze([...required].sort());
};

const channelAvailability = (profile) => Object.freeze({
  http_get: profile.transport.safeHttp === true,
  mapped_identity: profile.source.mappedIdentity === true,
  html_extract: profile.source.staticHtmlExtraction === true,
  json_scalar_extract: profile.jsonPath.scalarSegments === true,
  http_post: profile.httpWorkflow.post === true,
  linear_workflow: profile.httpWorkflow.linear === true,
  relative_url_resolution: profile.htmlExtraction.relativeUrlResolution === true,
  hls: profile.media.directHls === true,
  direct_mp4: profile.media.directHttpFile === true,
  persistent_session: false,
  javascript_transform: false,
  browser_automation: false,
  manifest_synthesis: false,
  html_regex_transform: profile.htmlExtraction.arbitraryRegexTransform === true,
  array_iteration: false,
  proxy_or_geo: false,
  unknown_pattern: false,
});

const assessChannel = (pattern, missing) => {
  const gaps = new Set(missing);
  if (gaps.has('browser_automation')) return ['UNSUPPORTED_BROWSER', 'BROWSER_OR_ANTIBOT_REQUIRED'];
  if (gaps.has('persistent_session')) return ['UNSUPPORTED_SESSION', 'PERSISTENT_SESSION_REQUIRED'];
  if (gaps.has('javascript_transform')) {
    return ['UNSUPPORTED_JAVASCRIPT', 'JAVASCRIPT_TRANSFORM_REQUIRED'];
  }
  if (gaps.has('manifest_synthesis')) return ['UNSUPPORTED_MANIFEST', 'MANIFEST_SYNTHESIS_REQUIRED'];
  if (pattern === 'UNKNOWN' || gaps.has('unknown_pattern')) {
    return ['UNKNOWN', 'INSUFFICIENT_STATIC_EVIDENCE'];
  }
  if (gaps.size > 0) {
    return ['NEEDS_SMALL_GENERIC_COMPONENT', 'BOUNDED_GENERIC_CAPABILITY_MISSING'];
  }
  return ['MAPPABLE_WITH_CURRENT_COMPONENTS', 'GENERIC_DISCOVERY_PRIMITIVES_AVAILABLE'];
};

const confidenceFor = (signals, pattern) => {
  const count = signals.identitySignals.length + signals.catalogSignals.length +
    signals.episodeSignals.length + signals.sourceSignals.length + signals.blockerSignals.length;
  if (pattern === 'UNKNOWN') return 'low';
  return count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';
};

const emptyCounts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const resolveChannelsFolder = (root) => {
  const absolute = path.resolve(root);
  return path.basename(absolute).toLowerCase() === 'channels'
    ? absolute : path.join(absolute, 'channels');
};

const scanTopLevelChannelCoverageV2 = ({ root, maxFiles = MAX_CHANNEL_FILES,
  maxFileBytes = MAX_CHANNEL_BYTES, profile = createKanchitaCapabilityProfile() } = {}) => {
  if (typeof root !== 'string' || !root.trim() || !Number.isInteger(maxFiles) || maxFiles < 1 ||
      maxFiles > MAX_CHANNEL_FILES || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 ||
      maxFileBytes > MAX_CHANNEL_BYTES) {
    throw Object.assign(new Error('KODI_CHANNEL_COVERAGE_V2_INVALID_INPUT'),
      { code: 'KODI_CHANNEL_COVERAGE_V2_INVALID_INPUT' });
  }
  const folder = resolveChannelsFolder(root);
  const entries = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.py$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > maxFiles) {
    throw Object.assign(new Error('KODI_CHANNEL_COVERAGE_V2_FILE_LIMIT'),
      { code: 'KODI_CHANNEL_COVERAGE_V2_FILE_LIMIT' });
  }
  const availability = channelAvailability(profile);
  const channels = [];
  let emptyInitFiles = 0;
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    const stat = fs.statSync(file);
    if (stat.size > maxFileBytes) {
      throw Object.assign(new Error('KODI_CHANNEL_COVERAGE_V2_FILE_TOO_LARGE'),
        { code: 'KODI_CHANNEL_COVERAGE_V2_FILE_TOO_LARGE' });
    }
    const content = fs.readFileSync(file);
    if (content.includes(0)) {
      throw Object.assign(new Error('KODI_CHANNEL_COVERAGE_V2_BINARY_FILE'),
        { code: 'KODI_CHANNEL_COVERAGE_V2_BINARY_FILE' });
    }
    const text = content.toString('utf8');
    if (entry.name.toLowerCase() === '__init__.py') {
      if (!text.trim()) emptyInitFiles += 1;
      continue;
    }
    const signals = detectChannelSignals(text);
    const pattern = deriveChannelPattern(signals);
    const required = requiredCapabilities(signals, pattern);
    const missing = required.filter((capability) => availability[capability] !== true);
    const [assessment, reason] = assessChannel(pattern, missing);
    channels.push(freeze({ channel: safeId(entry.name), files: 1, pattern,
      identitySignals: signals.identitySignals, catalogSignals: signals.catalogSignals,
      episodeSignals: signals.episodeSignals, sourceSignals: signals.sourceSignals,
      blockerSignals: signals.blockerSignals, requiredCapabilities: required,
      missingCapabilities: missing, assessment, confidence: confidenceFor(signals, pattern),
      reason }));
  }
  const byPattern = emptyCounts(CHANNEL_PATTERNS);
  const byAssessment = emptyCounts(CHANNEL_ASSESSMENTS);
  const blockers = new Map();
  for (const channel of channels) {
    byPattern[channel.pattern] += 1;
    byAssessment[channel.assessment] += 1;
    for (const capability of channel.missingCapabilities) {
      blockers.set(capability, (blockers.get(capability) || 0) + 1);
    }
  }
  const missingCapabilities = [...blockers.entries()]
    .map(([missingCapability, affectedChannels]) => ({ missingCapability, affectedChannels }))
    .sort((left, right) => right.affectedChannels - left.affectedChannels ||
      left.missingCapability.localeCompare(right.missingCapability));
  return freeze({ runtimeCommit: RUNTIME_COMMIT,
    population: { topLevelFiles: entries.length, channels: channels.length, emptyInitFiles },
    summary: { byPattern, byAssessment, missingCapabilities }, channels });
};

module.exports = {
  CHANNEL_ASSESSMENTS,
  CHANNEL_PATTERNS,
  MAX_CHANNEL_BYTES,
  MAX_CHANNEL_FILES,
  assessChannel,
  detectChannelSignals,
  deriveChannelPattern,
  requiredCapabilities,
  scanTopLevelChannelCoverageV2,
};
