'use strict';

const ARCHITECTURE_FAMILIES = Object.freeze([
  'DECLARATIVE_HTML',
  'DIRECT_MEDIA',
  'HLS_WITH_HEADERS',
  'HTTP_API',
  'SESSION_HTTP',
  'JAVASCRIPT_TRANSFORM',
  'MANIFEST_SYNTHESIS',
  'UNKNOWN',
]);

const SIGNAL_RULES = Object.freeze([
  ['manifest_extm3u', /#EXTM3U/i],
  ['manifest_extinf', /#EXTINF/i],
  ['manifest_byterange', /#EXT-X-BYTERANGE/i],
  ['writes_m3u8', /(?:open|write|save|file)[^\r\n]{0,160}\.m3u8|\.m3u8[^\r\n]{0,160}(?:open|write|save)/i],
  ['consumes_set_cookie', /(?:set-cookie[^\r\n]{0,120}(?:get|parse|load)|(?:getheader|headers?\.get)[^\r\n]{0,80}set-cookie)/i],
  ['forwards_cookie', /(?:['"]cookie['"]\s*:|cookie\s*=)/i],
  ['uses_referer', /referer/i],
  ['uses_origin', /(?:['"]origin['"]\s*:|headers?[^\r\n]{0,80}\borigin\b)/i],
  ['json_endpoint', /json\.(?:loads?|decode)|response\.json|\.json(?:\?|['"]|\b)|\/api\//i],
  ['extracts_iframe', /<iframe|iframe[^\r\n]{0,100}(?:src|find|extract)|embed(?:_url)?/i],
  ['direct_m3u8', /\.m3u8(?:\?|['"\s]|$)|mpegurl/i],
  ['direct_mp4', /\.mp4(?:\?|['"\s]|$)|video\/mp4/i],
]);

const OBSERVATION_RULES = Object.freeze([
  ['httptools.downloadpage', /httptools\.downloadpage/i],
  ['requests.get', /requests?\.get\s*\(/i],
  ['requests.post', /requests?\.post\s*\(/i],
  ['urllib.urlopen', /(?:urllib(?:2)?\.)?urlopen\s*\(/i],
  ['scrapertools.cache_page', /scrapertools\.cache_page/i],
  ['html.parser', /beautifulsoup|html\.parser|scrapertools\.get_match/i],
  ['regex.re', /\bre\.(?:compile|findall|finditer|match|search|sub)\s*\(/i],
  ['regex.scrapertools', /scrapertools\.(?:find_multiple_matches|find_single_match)/i],
  ['servertools.resolve_video_urls', /servertools\.resolve_video_urls/i],
  ['servertools.find_video_items', /servertools\.find_video_items/i],
  ['servertools.get_server_from_url', /servertools\.get_server_from_url/i],
  ['media.m3u8', /\.m3u8(?:\?|['"\s]|$)|mpegurl/i],
  ['media.mp4', /\.mp4(?:\?|['"\s]|$)|video\/mp4/i],
  ['headers.referer', /referer/i],
  ['headers.origin', /['"]origin['"]\s*:/i],
  ['headers.cookie', /(?:['"]cookie['"]\s*:|cookie\s*=)/i],
  ['headers.generic', /(?:request_)?headers?\s*=/i],
  ['cookies.set_cookie', /set-cookie/i],
  ['json.loads', /json\.(?:load|loads|decode)/i],
  ['json.response', /response\.json/i],
  ['helper.m3u8server.Client', /m3u8server\.Client\s*\(|from\s+(?:[\w.]+\.)?m3u8server\s+import\s+Client/i],
  ['download.file_host_semantics', /\b(?:download|downloads|filehost|file_factory|premium_account)\b/i],
]);

const detectArchitectureSignals = (text) => Object.freeze(SIGNAL_RULES
  .filter(([, pattern]) => pattern.test(String(text)))
  .map(([name]) => name));

const detectArchitectureObservations = (text) => {
  const observations = OBSERVATION_RULES
    .filter(([, pattern]) => pattern.test(String(text)))
    .map(([name]) => name);
  const hasHttpPrimitive = observations.some((name) => [
    'httptools.downloadpage', 'requests.get', 'requests.post', 'urllib.urlopen',
    'scrapertools.cache_page',
  ].includes(name));
  const hasServertoolsDelegation = observations.some((name) =>
    name.startsWith('servertools.'));
  if (hasServertoolsDelegation && !hasHttpPrimitive) {
    observations.push('delegation.servertools_only');
  }
  return Object.freeze([...new Set(observations)].sort());
};

const deriveArchitectureFamily = ({ classifications = [], signals = [] } = {}) => {
  const capabilitySet = new Set(Array.isArray(classifications) ? classifications : []);
  const signalSet = new Set(Array.isArray(signals) ? signals : []);
  const synthesizesManifest = signalSet.has('manifest_extm3u') &&
    (signalSet.has('manifest_extinf') || signalSet.has('manifest_byterange') ||
      signalSet.has('writes_m3u8'));
  if (synthesizesManifest) return 'MANIFEST_SYNTHESIS';
  if (capabilitySet.has('javascript_transform')) return 'JAVASCRIPT_TRANSFORM';
  if (capabilitySet.has('cookie_session') || signalSet.has('consumes_set_cookie') ||
      signalSet.has('forwards_cookie')) return 'SESSION_HTTP';
  if ((capabilitySet.has('direct_hls') || signalSet.has('direct_m3u8')) &&
      (capabilitySet.has('header_bound') || signalSet.has('uses_referer') ||
        signalSet.has('uses_origin'))) return 'HLS_WITH_HEADERS';
  if (capabilitySet.has('json_api') || signalSet.has('json_endpoint')) return 'HTTP_API';
  if (capabilitySet.has('iframe_http') || capabilitySet.has('static_html') ||
      signalSet.has('extracts_iframe')) return 'DECLARATIVE_HTML';
  if (capabilitySet.has('direct_hls') || signalSet.has('direct_m3u8') ||
      signalSet.has('direct_mp4')) return 'DIRECT_MEDIA';
  return 'UNKNOWN';
};

const createArchitectureSummary = (records = []) => {
  if (!Array.isArray(records)) {
    throw Object.assign(new Error('KODI_ARCHITECTURE_INVALID_INPUT'),
      { code: 'KODI_ARCHITECTURE_INVALID_INPUT' });
  }
  const counts = Object.fromEntries(ARCHITECTURE_FAMILIES.map((family) => [family, 0]));
  const servers = records.filter((record) => record?.kind === 'server');
  for (const record of servers) {
    const family = ARCHITECTURE_FAMILIES.includes(record.architectureFamily)
      ? record.architectureFamily : 'UNKNOWN';
    counts[family] += 1;
  }
  return Object.freeze({ total: servers.length, ...counts });
};

const createArchitectureDetails = (records = []) => {
  if (!Array.isArray(records)) {
    throw Object.assign(new Error('KODI_ARCHITECTURE_INVALID_INPUT'),
      { code: 'KODI_ARCHITECTURE_INVALID_INPUT' });
  }
  const grouped = Object.fromEntries(ARCHITECTURE_FAMILIES
    .map((family) => [family, new Set()]));
  for (const record of records) {
    if (record?.kind !== 'server' || typeof record.id !== 'string' || !record.id) continue;
    const family = ARCHITECTURE_FAMILIES.includes(record.architectureFamily)
      ? record.architectureFamily : 'UNKNOWN';
    grouped[family].add(record.id);
  }
  const serversByArchitecture = Object.freeze(Object.fromEntries(
    ARCHITECTURE_FAMILIES.map((family) =>
      [family, Object.freeze([...grouped[family]].sort())])));
  return Object.freeze({
    counts: createArchitectureSummary(records),
    serversByArchitecture,
  });
};

const createUnknownArchitectureExplanation = (records = []) => {
  if (!Array.isArray(records)) {
    throw Object.assign(new Error('KODI_ARCHITECTURE_INVALID_INPUT'),
      { code: 'KODI_ARCHITECTURE_INVALID_INPUT' });
  }
  const unknownIds = new Set(records.filter((record) => record?.kind === 'server' &&
    record.architectureFamily === 'UNKNOWN' && typeof record.id === 'string' && record.id)
    .map(({ id }) => id));
  const grouped = new Map();
  for (const record of records) {
    if (record?.kind !== 'server' || !unknownIds.has(record.id)) continue;
    if (!grouped.has(record.id)) {
      grouped.set(record.id, { files: 0, matchedSignals: new Set(),
        observedSignals: new Set(), hasClassifiedSibling: false });
    }
    const group = grouped.get(record.id);
    group.files += 1;
    if (record.architectureFamily === 'UNKNOWN') {
      for (const signal of Array.isArray(record.architectureSignals)
        ? record.architectureSignals : []) group.matchedSignals.add(signal);
    } else {
      group.hasClassifiedSibling = true;
    }
    for (const signal of Array.isArray(record.architectureObservations)
      ? record.architectureObservations : []) group.observedSignals.add(signal);
  }
  return Object.freeze([...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right)).map(([server, group]) => Object.freeze({
    server,
    files: group.files,
    matchedSignals: Object.freeze([...group.matchedSignals].sort()),
    observedSignals: Object.freeze([...group.observedSignals].sort()),
    reason: group.hasClassifiedSibling
      ? 'UNKNOWN_FILE_WITH_CLASSIFIED_SIBLING' : 'NO_ARCHITECTURE_RULE_MATCH',
  })));
};

module.exports = {
  ARCHITECTURE_FAMILIES,
  OBSERVATION_RULES,
  SIGNAL_RULES,
  createArchitectureDetails,
  createArchitectureSummary,
  createUnknownArchitectureExplanation,
  deriveArchitectureFamily,
  detectArchitectureObservations,
  detectArchitectureSignals,
};
