'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GENERIC = Object.freeze(['multi_value_extract', 'array_iteration',
  'scalar_capture_chaining', 'repeated_capture', 'safe_regex_single_capture',
  'safe_regex_multi_capture', 'static_decode', 'bounded_rewrite',
  'redirect_resolution', 'persistent_public_session']);
const PLATFORM = Object.freeze(['direct_mp4_resolver', 'mp4_primary_acceptance',
  'mp4_lifecycle', 'mp4_api_contract']);
const MP4_BUNDLE = PLATFORM;
const AVAILABLE = Object.freeze(['get_post', 'json_scalar_path', 'html_selector',
  'literal_response_body_capture', 'mapped_http_workflow', 'exact_mapping',
  'bounded_redirects', 'hls_resolver', 'playback_headers', 'multi_hop',
  'catalog_runtime']);
const EXCLUDED = new Set(['javascript_transform', 'browser', 'antibot',
  'protected', 'proxy_geo', 'unknown_pattern', 'manifest_synthesis',
  'dynamic_regex', 'external_helper', 'exact_item_not_proven', 'unknown_flow']);
const CAPABILITIES = Object.freeze([...GENERIC, ...PLATFORM].sort());
const sorted = (values) => [...new Set(values)].sort();
const contains = (source, pattern) => pattern.test(source);
const moduleId = (record) => `${record.kind}:${record.id}`;

const readSource = (root, record) => {
  const chunks = [];
  for (const file of record.files || []) {
    if (!/^(?:channels|servers)\/[a-z0-9_-]+\.py$/i.test(file)) continue;
    const full = path.join(path.resolve(root), ...file.split('/'));
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 1024 * 1024) continue;
    const bytes = fs.readFileSync(full);
    if (!bytes.includes(0)) chunks.push(bytes.toString('utf8'));
  }
  return chunks.join('\n').split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line)).join('\n');
};

const inspectRequirements = (record, source = '') => {
  const missing = new Set();
  const blockers = new Set();
  const original = new Set(record.missingCapabilities || []);
  for (const item of record.excludedBlockers || []) {
    const normalized = item === 'javascript' ? 'javascript_transform'
      : item === 'session' ? 'persistent_public_session'
        : item === 'antibot' ? 'antibot'
          : item === 'dynamic_regex' ? 'unknown_pattern' : item;
    if (EXCLUDED.has(normalized)) blockers.add(normalized);
    else if (normalized === 'persistent_public_session') missing.add(normalized);
    else blockers.add('unknown_pattern');
  }
  for (const item of original) {
    if (item === 'direct_mp4') MP4_BUNDLE.forEach((part) => missing.add(part));
    else if (GENERIC.includes(item)) missing.add(item);
    else if (!AVAILABLE.includes(item)) blockers.add('unknown_pattern');
  }

  const hasSingle = contains(source,
    /scrapertools\.(?:find_single_match|get_match)\s*\(|\bre\.search\s*\(/i);
  const hasMultiple = contains(source, /scrapertools\.find_multiple_matches\s*\(|\bre\.findall\s*\(/i);
  const hasRegex = hasSingle || hasMultiple || contains(source, /\bre\.compile\s*\(/i);
  const hasArray = contains(source, /\bfor\s+\w+(?:\s*,\s*\w+)*\s+in\s+(?:data|data_json|lista|videos|items|episodes|calidades|matches)(?:\b|\[)/i);
  const hasJsonArray = contains(source, /\[['"](?:list|items|results|files|data|response|sources)['"]\]/i);
  const mp4Output = contains(source, /(?:video_urls\.append|video_urls\s*=|lbl\s*=)[^\r\n]{0,100}['"]mp4['"]|page_url\[-4:\]|fileDownloadUrl|\.mp4\b/i);
  if (mp4Output) MP4_BUNDLE.forEach((part) => missing.add(part));
  if (hasArray && (hasJsonArray || contains(source,
    /(?:data_json|lista)\s*=\s*(?:jsontools\.load|data_json)|\bfor\s+\w+\s+in\s+lista\s*:/i))) {
    missing.add('array_iteration');
  }
  if (hasMultiple) missing.add('multi_value_extract');
  if (contains(source, /\bre\.finditer\s*\(|\bfor\s+\w+\s+in\s+\w*matches\b/i)) {
    missing.add('repeated_capture');
  }
  if (hasSingle) missing.add('safe_regex_single_capture');
  if (contains(source, /(?:find_multiple_matches|re\.findall)\s*\([^\r\n]{0,180}\([^)]*\)[^\r\n]{0,80}\([^)]*\)/i)) {
    missing.add('safe_regex_multi_capture');
  }
  if (contains(source, /find_single_match\s*\(\s*(?:vid|url|page_url|article|bloque|dataid|item\.)/i)) {
    missing.add('scalar_capture_chaining');
  }
  if (contains(source, /jsontools\.load\s*\(\s*(?:bloque|match|captur\w*)\s*\)/i) ||
      contains(source, /(?:b64decode|base64\.b64decode|unquote|html\.unescape|decodeHtmlentities)/i)) {
    missing.add('static_decode');
  }
  if (contains(source, /\bre\.sub\s*\(|\.replace\s*\(/i)) missing.add('bounded_rewrite');
  if (contains(source, /follow_redirects\s*=\s*False|only_headers\s*=\s*True|headers?\.get\(['"]location/i)) {
    missing.add('redirect_resolution');
  }
  if (contains(source, /\b(?:cookiejar|requests?\.session|set-cookie)\b/i)) {
    missing.add('persistent_public_session');
  }
  if (contains(source, /\b(?:exec|eval)\s*\(|jsunpack|selenium|playwright|puppeteer|captcha|cloudflare|widevine|fairplay|playready/i)) {
    blockers.add('javascript_transform');
  }
  if (record.kind === 'server' && contains(source, /video_urls\.append|video_urls\s*=/i) &&
      !contains(source, /\[['"](?:mp4|hls|m3u8)['"]|\.mp4\b|\.m3u8\b|fileDownloadUrl/i)) {
    blockers.add('unknown_flow');
  }
  if (contains(source, /balandroresolver\.decode_video_\w+\s*\(/i)) {
    blockers.add('unknown_pattern');
  }
  if (contains(source, /document\.cookie|\bck\s*=\s*scrapertools\.find_single_match/i)) {
    blockers.add('unknown_pattern');
  }
  if (contains(source, /re\.compile\s*\(\s*\w+\s*\+|find_single_match\([^\r\n]{0,180}['"][^'"]*%s[^'"]*['"]\s*%/i)) {
    blockers.add('unknown_pattern');
  }
  if (hasRegex && contains(source, /\(\?<=|\(\?<!|\\[1-9]|\(\?P</i)) {
    blockers.add('unknown_pattern');
  }
  if (record.kind === 'channel' &&
      !(record.identitySignals || []).includes('exact_item_endpoint')) {
    blockers.add('exact_item_not_proven');
  }
  if (record.migrationStatus === 'MANUAL_REVIEW' &&
      !(record.files || []).some((file) => file.endsWith('.py'))) blockers.add('unknown_flow');
  if (record.migrationStatus === 'MANUAL_REVIEW' && missing.size === 0) {
    blockers.add('unknown_flow');
  }
  if (record.migrationFamily === 'UNKNOWN' && !source.trim()) blockers.add('unknown_flow');
  return { missingCapabilitySet: sorted(missing), excludedBlockers: sorted(blockers) };
};

const createProfile = (record, source = '') => {
  if (!record || !['channel', 'server'].includes(record.kind) ||
      typeof record.id !== 'string') throw new Error('MINIMUM_BUNDLE_INVALID_RECORD');
  const requirements = inspectRequirements(record, source);
  const platformGaps = requirements.missingCapabilitySet.filter((item) => PLATFORM.includes(item));
  const currentRuntimeSatisfied = requirements.missingCapabilitySet.length === 0 &&
    requirements.excludedBlockers.length === 0;
  const potentiallyMigratable = requirements.excludedBlockers.length === 0;
  return Object.freeze({ id: record.id, kind: record.kind,
    migrationFamily: record.migrationFamily || 'UNKNOWN', currentRuntimeSatisfied,
    missingCapabilitySet: requirements.missingCapabilitySet, platformGaps,
    excludedBlockers: requirements.excludedBlockers,
    minimumBundleSize: potentiallyMigratable ? requirements.missingCapabilitySet.length : null,
    potentiallyMigratable });
};

const combinations = (items, size, start = 0, prefix = [], output = []) => {
  if (prefix.length === size) { output.push(prefix); return output; }
  for (let index = start; index < items.length; index += 1) {
    combinations(items, size, index + 1, [...prefix, items[index]], output);
  }
  return output;
};

const evaluateBundle = (profiles, capabilities) => {
  const set = new Set(capabilities);
  const affected = profiles.filter((item) => item.missingCapabilitySet.some((part) => set.has(part)));
  const unlocked = affected.filter((item) => item.potentiallyMigratable &&
    item.missingCapabilitySet.every((part) => set.has(part)));
  return Object.freeze({ capabilities: sorted(capabilities), fullUnlockDelta: unlocked.length,
    affectedModules: affected.length, remainingBlockedModules: affected.length - unlocked.length,
    unlockedIds: unlocked.map(moduleId).sort() });
};

const createMinimumCapabilityBundles = ({ manifest, sources = {} } = {}) => {
  if (!Array.isArray(manifest) || !sources || typeof sources !== 'object') {
    throw new Error('MINIMUM_BUNDLE_INVALID_INPUT');
  }
  const profiles = manifest.map((record) => createProfile(record,
    sources[moduleId(record)] || '')).sort((a, b) =>
    moduleId(a).localeCompare(moduleId(b)));
  const bundles = [1, 2, 3].flatMap((size) => combinations(CAPABILITIES, size)
    .map((set) => evaluateBundle(profiles, set)))
    .sort((a, b) => b.fullUnlockDelta - a.fullUnlockDelta ||
      a.capabilities.length - b.capabilities.length ||
      b.affectedModules - a.affectedModules ||
      a.capabilities.join('+').localeCompare(b.capabilities.join('+')));
  const distribution = Object.fromEntries(['0', '1', '2', '3', '4+', 'blocked']
    .map((key) => [key, 0]));
  for (const item of profiles) {
    distribution[item.minimumBundleSize === null ? 'blocked'
      : item.minimumBundleSize >= 4 ? '4+' : String(item.minimumBundleSize)] += 1;
  }
  const best = (size) => bundles.find((item) => item.capabilities.length === size);
  const blockerCounts = new Map();
  for (const item of profiles) for (const blocker of item.excludedBlockers) {
    blockerCounts.set(blocker, (blockerCounts.get(blocker) || 0) + 1);
  }
  return Object.freeze({ profiles, bundles, summary: Object.freeze({
    totalUniqueModules: profiles.length,
    representableToday: profiles.filter((item) => item.currentRuntimeSatisfied)
      .map(moduleId), minimumBundleSizeDistribution: distribution,
    top15Bundles: bundles.slice(0, 15), bestSize1: best(1), bestSize2: best(2),
    bestSize3: best(3), excludedBlockers: [...blockerCounts]
      .map(([blocker, modules]) => ({ blocker, modules }))
      .sort((a, b) => b.modules - a.modules || a.blocker.localeCompare(b.blocker)),
  }) });
};

const scanMinimumCapabilityBundles = ({ root, manifestPath } = {}) => {
  if (typeof root !== 'string' || typeof manifestPath !== 'string') {
    throw new Error('MINIMUM_BUNDLE_INVALID_INPUT');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sources = Object.create(null);
  for (const record of manifest) sources[moduleId(record)] = readSource(root, record);
  return createMinimumCapabilityBundles({ manifest, sources });
};

module.exports = { AVAILABLE, CAPABILITIES, GENERIC, PLATFORM,
  createProfile, evaluateBundle, createMinimumCapabilityBundles,
  scanMinimumCapabilityBundles };
