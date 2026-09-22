'use strict';

const {
  CAPABILITY_NAMES,
  CAPABILITY_STATES,
  createV2CapabilityMatrix,
} = require('./v2CapabilityMatrix');

const COVERAGE = Object.freeze([
  'primary', 'resolution_only', 'requires_session', 'requires_javascript',
  'requires_browser', 'protected', 'unknown',
]);
const CAPABILITY_SET = new Set(CAPABILITY_NAMES);
const CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
const CONFIDENCE_SET = new Set(CONFIDENCE);
const BLOCKERS = Object.freeze([
  'drm_or_protected', 'anti_bot', 'browser_required', 'javascript_transform',
  'cookie_session', 'playback_header_bound', 'header_bound',
]);
const MAX_COMBINATIONS = 20;

const lowerConfidence = (value) => {
  const index = CONFIDENCE.indexOf(value);
  return CONFIDENCE[Math.max(0, index - 1)];
};
const normalizeCapabilities = (entry) => {
  const source = Array.isArray(entry?.classifications)
    ? entry.classifications : Array.isArray(entry?.capabilities) ? entry.capabilities : [];
  const known = [...new Set(source.filter((item) =>
    typeof item === 'string' && CAPABILITY_SET.has(item)))].sort();
  return known.length ? known : ['unknown'];
};
const signatureFor = (capabilities) => capabilities.slice().sort().join('+');

const classifyServerCoverage = (entry, { headerTransportReady = false } = {}) => {
  const matchedCapabilities = normalizeCapabilities(entry);
  const set = new Set(matchedCapabilities);
  const transportReady = headerTransportReady === true;
  const hasHeaderBound = set.has('playback_header_bound') || set.has('header_bound');
  let coverage = 'unknown';
  let blockingCapabilities = [];
  if (set.has('drm_or_protected')) {
    coverage = 'protected';
    blockingCapabilities = ['drm_or_protected'];
  } else if (set.has('browser_required') || set.has('anti_bot')) {
    coverage = 'requires_browser';
    blockingCapabilities = ['anti_bot', 'browser_required'].filter((item) => set.has(item));
  } else if (set.has('javascript_transform')) {
    coverage = 'requires_javascript';
    blockingCapabilities = ['javascript_transform'];
  } else if (set.has('cookie_session')) {
    coverage = 'requires_session';
    blockingCapabilities = ['cookie_session'];
  } else if (!transportReady && hasHeaderBound) {
    coverage = 'resolution_only';
    blockingCapabilities = ['playback_header_bound', 'header_bound']
      .filter((item) => set.has(item));
  } else if (transportReady && hasHeaderBound && set.has('unknown')) {
    coverage = 'unknown';
  } else if (matchedCapabilities.some((item) =>
    createV2CapabilityMatrix({ headerTransportReady: transportReady })[item]?.state ===
      CAPABILITY_STATES.SUPPORTED_PRIMARY)) {
    coverage = 'primary';
  }
  let confidence = CONFIDENCE_SET.has(entry?.confidence) ? entry.confidence : 'low';
  if (set.has('unknown') && matchedCapabilities.length > 1) confidence = lowerConfidence(confidence);
  return Object.freeze({
    coverage,
    matchedCapabilities: Object.freeze(matchedCapabilities),
    blockingCapabilities: Object.freeze(blockingCapabilities),
    confidence,
  });
};

const safeRatio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const createCoverageSummary = (entries = [], options = {}) => {
  if (!Array.isArray(entries)) {
    const error = new Error('CAPABILITY_COVERAGE_INVALID_INPUT');
    error.code = 'CAPABILITY_COVERAGE_INVALID_INPUT';
    throw error;
  }
  const servers = entries.filter((entry) => entry && typeof entry === 'object' &&
    !Array.isArray(entry) && (entry.kind === undefined || entry.kind === 'server'));
  const eligibleEntries = servers.filter(({ inactive }) => inactive !== true);
  const counts = Object.fromEntries(COVERAGE.map((name) => [name, 0]));
  const blockers = Object.fromEntries(BLOCKERS.map((name) => [name, 0]));
  const confidence = Object.fromEntries(CONFIDENCE.map((name) => [name, 0]));
  const combinations = new Map();
  for (const entry of eligibleEntries) {
    const result = classifyServerCoverage(entry, options);
    counts[result.coverage] += 1;
    confidence[result.confidence] += 1;
    for (const blocker of result.blockingCapabilities) blockers[blocker] += 1;
    const signature = signatureFor(result.matchedCapabilities);
    combinations.set(signature, (combinations.get(signature) || 0) + 1);
  }
  const topCombinations = [...combinations.entries()]
    .map(([signature, count]) => Object.freeze({ signature, count }))
    .sort((left, right) => right.count - left.count ||
      left.signature.localeCompare(right.signature))
    .slice(0, MAX_COMBINATIONS);
  const eligible = eligibleEntries.length;
  const primaryCompatible = counts.primary;
  const resolutionOnly = counts.resolution_only;
  return Object.freeze({
    total: servers.length,
    totalScanned: servers.length,
    activeOrUnknownStatus: eligible,
    inactive: servers.length - eligible,
    eligible,
    primaryCompatible,
    resolutionOnly,
    requiresSession: counts.requires_session,
    requiresJavascript: counts.requires_javascript,
    requiresBrowser: counts.requires_browser,
    protected: counts.protected,
    unknown: counts.unknown,
    coveragePercent: safeRatio(primaryCompatible, eligible),
    technicalCoveragePercent: safeRatio(primaryCompatible + resolutionOnly, eligible),
    blockingCapabilityCounts: Object.freeze(blockers),
    confidence: Object.freeze({
      highConfidence: confidence.high,
      mediumConfidence: confidence.medium,
      lowConfidence: confidence.low,
    }),
    topCombinations: Object.freeze(topCombinations),
  });
};

const recommendNextCapability = (summary) => {
  const candidates = [
    ['playback_headers', summary?.resolutionOnly],
    ['cookie_session', summary?.requiresSession],
    ['javascript_transform', summary?.requiresJavascript],
    ['browser_required', summary?.requiresBrowser],
  ].map(([recommendedCapability, count], priority) => ({
    recommendedCapability,
    affectedServers: Number.isInteger(count) && count > 0 ? count : 0,
    priority,
  })).sort((left, right) => right.affectedServers - left.affectedServers ||
    left.priority - right.priority);
  const selected = candidates[0];
  if (!selected || selected.affectedServers === 0) {
    return Object.freeze({ recommendedCapability: 'none', affectedServers: 0,
      reasonCode: 'NO_SUPPORTED_ARCHITECTURAL_INVESTMENT' });
  }
  return Object.freeze({
    recommendedCapability: selected.recommendedCapability,
    affectedServers: selected.affectedServers,
    reasonCode: 'LARGEST_REMAINING_ARCHITECTURAL_BLOCK',
  });
};

module.exports = {
  BLOCKERS,
  COVERAGE,
  MAX_COMBINATIONS,
  classifyServerCoverage,
  createCoverageSummary,
  recommendNextCapability,
  signatureFor,
};
