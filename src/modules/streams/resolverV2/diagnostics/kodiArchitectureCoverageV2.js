'use strict';

const { ARCHITECTURE_FAMILIES, deriveArchitectureFamily } = require('./kodiArchitecture');

const RUNTIME_COMMIT = '0ea33378f38e349d5b2168974c6ec861ab406d0e';
const ASSESSMENTS = Object.freeze([
  'REPRESENTABLE_NOW',
  'NEEDS_PROVIDER_CONFIG',
  'NEEDS_SMALL_GENERIC_COMPONENT',
  'UNSUPPORTED_SESSION',
  'UNSUPPORTED_JAVASCRIPT',
  'UNSUPPORTED_BROWSER',
  'UNSUPPORTED_MANIFEST',
  'UNKNOWN',
]);

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const createKanchitaCapabilityProfile = () => deepFreeze({
  runtimeCommit: RUNTIME_COMMIT,
  transport: {
    safeHttp: true,
    methods: ['GET', 'HEAD', 'POST'],
    boundedBody: true,
    boundedRedirects: true,
    ssrfFailClosed: true,
  },
  media: {
    directHls: true,
    directHttpFile: false,
    hlsInspection: true,
    playbackHeaders: true,
    playbackTransport: true,
    playbackHeaderNames: ['origin', 'referer'],
    playbackTransportRequired: true,
  },
  source: {
    mappedIdentity: true,
    declarativeCatalog: true,
    mappedHttpWorkflow: true,
    staticHtmlExtraction: true,
    jsonApi: true,
  },
  httpWorkflow: {
    linear: true,
    maxSteps: 8,
    get: true,
    post: true,
    loops: false,
    branches: false,
    retries: false,
  },
  jsonPath: {
    scalarSegments: true,
    boundedArrayIndex: true,
    maximumArrayIndex: 31,
    wildcards: false,
    objectProjection: false,
  },
  htmlExtraction: {
    tagSelector: true,
    requiredAttributeSelector: true,
    attributeValue: true,
    boundedText: true,
    relativeUrlResolution: true,
    arbitraryCss: false,
    arbitraryRegexTransform: false,
  },
  resolutionGraph: {
    boundedMultiHop: true,
    maximumDepth: 4,
    maximumNodes: 64,
    parallelBranches: false,
  },
  unsupported: {
    persistentCookies: false,
    arbitrarySessionState: false,
    javascriptTransform: false,
    browserAutomation: false,
    antiBotBypass: false,
    drm: false,
    arbitraryManifestSynthesis: false,
  },
});

const capabilityAvailability = (profile) => Object.freeze({
  http: profile.transport.safeHttp === true,
  hls: profile.media.directHls === true,
  direct_http: profile.media.directHttpFile === true,
  html_extract: profile.source.staticHtmlExtraction === true,
  html_attribute_extract: profile.htmlExtraction.attributeValue === true,
  html_regex_transform: profile.htmlExtraction.arbitraryRegexTransform === true,
  json_api: profile.source.jsonApi === true,
  json_scalar_extract: profile.jsonPath.scalarSegments === true,
  http_post: profile.httpWorkflow.post === true,
  mapped_identity: profile.source.mappedIdentity === true,
  relative_url_resolution: profile.htmlExtraction.relativeUrlResolution === true,
  playback_headers: profile.media.playbackHeaders === true &&
    profile.media.playbackTransport === true,
  referer: profile.media.playbackHeaderNames.includes('referer'),
  origin: profile.media.playbackHeaderNames.includes('origin'),
  bounded_multi_hop: profile.resolutionGraph.boundedMultiHop === true,
  persistent_session: profile.unsupported.persistentCookies === true &&
    profile.unsupported.arbitrarySessionState === true,
  javascript_transform: profile.unsupported.javascriptTransform === true,
  browser_automation: profile.unsupported.browserAutomation === true,
  anti_bot_bypass: profile.unsupported.antiBotBypass === true,
  drm: profile.unsupported.drm === true,
  manifest_synthesis: profile.unsupported.arbitraryManifestSynthesis === true,
  unknown_pattern: false,
});

const add = (set, ...values) => values.forEach((value) => set.add(value));
const deriveRequiredCapabilities = ({ architecture, classifications = [], signals = [],
  observations = [] } = {}) => {
  const required = new Set();
  const classes = new Set(classifications);
  const observed = new Set(observations);
  const detected = new Set(signals);
  if (architecture !== 'UNKNOWN') required.add('http');
  if (architecture === 'DECLARATIVE_HTML') add(required, 'html_extract', 'hls');
  if (architecture === 'HTTP_API') add(required, 'json_api', 'json_scalar_extract', 'hls');
  if (architecture === 'HLS_WITH_HEADERS') add(required, 'hls', 'playback_headers');
  if (architecture === 'DIRECT_MEDIA') {
    if (classes.has('direct_hls') || detected.has('direct_m3u8')) required.add('hls');
    if (detected.has('direct_mp4') && !detected.has('direct_m3u8')) required.add('direct_http');
  }
  if (architecture === 'SESSION_HTTP') required.add('persistent_session');
  if (architecture === 'JAVASCRIPT_TRANSFORM') required.add('javascript_transform');
  if (architecture === 'MANIFEST_SYNTHESIS') required.add('manifest_synthesis');
  if (architecture === 'UNKNOWN') required.add('unknown_pattern');
  if (classes.has('multi_hop_iframe')) required.add('bounded_multi_hop');
  if (classes.has('browser_required')) required.add('browser_automation');
  if (classes.has('anti_bot')) required.add('anti_bot_bypass');
  if (classes.has('drm_or_protected')) required.add('drm');
  if (classes.has('cookie_session')) required.add('persistent_session');
  if (classes.has('javascript_transform')) required.add('javascript_transform');
  if (classes.has('header_bound')) required.add('playback_headers');
  if (detected.has('uses_referer')) required.add('referer');
  if (detected.has('uses_origin')) required.add('origin');
  if (observed.has('requests.post')) required.add('http_post');
  if (architecture === 'DECLARATIVE_HTML' &&
      (observed.has('regex.re') || observed.has('regex.scrapertools')) &&
      !detected.has('extracts_iframe')) required.add('html_regex_transform');
  return Object.freeze([...required].sort());
};

const confidenceFor = (records, architecture) => {
  if (architecture === 'UNKNOWN') return 'low';
  const levels = records.map(({ confidence }) => ({ low: 1, medium: 2, high: 3 })[confidence] || 0);
  const level = Math.max(0, ...levels);
  return level >= 3 ? 'high' : level === 2 ? 'medium' : 'low';
};

const assess = ({ architecture, missingCapabilities, configured }) => {
  const missing = new Set(missingCapabilities);
  if (architecture === 'UNKNOWN' || missing.has('unknown_pattern') ||
      missing.has('anti_bot_bypass') || missing.has('drm')) {
    return ['UNKNOWN', 'INSUFFICIENT_OR_EXCLUDED_STATIC_EVIDENCE'];
  }
  if (missing.has('persistent_session')) return ['UNSUPPORTED_SESSION', 'PERSISTENT_SESSION_REQUIRED'];
  if (missing.has('javascript_transform')) {
    return ['UNSUPPORTED_JAVASCRIPT', 'JAVASCRIPT_TRANSFORM_REQUIRED'];
  }
  if (missing.has('browser_automation')) return ['UNSUPPORTED_BROWSER', 'BROWSER_REQUIRED'];
  if (missing.has('manifest_synthesis')) {
    return ['UNSUPPORTED_MANIFEST', 'MANIFEST_SYNTHESIS_REQUIRED'];
  }
  if (missing.size > 0) {
    return ['NEEDS_SMALL_GENERIC_COMPONENT', 'BOUNDED_GENERIC_CAPABILITY_MISSING'];
  }
  return configured
    ? ['REPRESENTABLE_NOW', 'EQUIVALENT_RUNTIME_CONFIGURATION_PRESENT']
    : ['NEEDS_PROVIDER_CONFIG', 'GENERIC_PRIMITIVES_AVAILABLE_CONFIGURATION_MISSING'];
};

const aggregateServers = (records) => {
  const grouped = new Map();
  for (const record of records) {
    if (record?.kind !== 'server' || typeof record.id !== 'string' || !record.id) continue;
    if (!grouped.has(record.id)) grouped.set(record.id, []);
    grouped.get(record.id).push(record);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
};

const createEmptyAssessmentCounts = () =>
  Object.fromEntries(ASSESSMENTS.map((assessment) => [assessment, 0]));

const createArchitectureCoverageV2 = (records = [], {
  profile = createKanchitaCapabilityProfile(),
  configuredServerIds = [],
} = {}) => {
  if (!Array.isArray(records) || !profile || typeof profile !== 'object' ||
      !Array.isArray(configuredServerIds)) {
    throw Object.assign(new Error('KODI_ARCHITECTURE_COVERAGE_V2_INVALID_INPUT'),
      { code: 'KODI_ARCHITECTURE_COVERAGE_V2_INVALID_INPUT' });
  }
  const availability = capabilityAvailability(profile);
  const configured = new Set(configuredServerIds.filter((id) => typeof id === 'string'));
  const servers = [];
  for (const [server, serverRecords] of aggregateServers(records)) {
    const classifications = [...new Set(serverRecords.flatMap((record) =>
      Array.isArray(record.classifications) ? record.classifications : []))].sort();
    const signals = [...new Set(serverRecords.flatMap((record) =>
      Array.isArray(record.architectureSignals) ? record.architectureSignals : []))].sort();
    const observations = [...new Set(serverRecords.flatMap((record) =>
      Array.isArray(record.architectureObservations) ? record.architectureObservations : []))]
      .sort();
    const architecture = deriveArchitectureFamily({ classifications, signals });
    const requiredCapabilities = deriveRequiredCapabilities({ architecture, classifications,
      signals, observations });
    const availableCapabilities = requiredCapabilities.filter((name) => availability[name] === true);
    const missingCapabilities = requiredCapabilities.filter((name) => availability[name] !== true);
    const [assessment, reason] = assess({ architecture, missingCapabilities,
      configured: configured.has(server) });
    servers.push(Object.freeze({ server, architecture, files: serverRecords.length,
      requiredCapabilities, availableCapabilities: Object.freeze(availableCapabilities),
      missingCapabilities: Object.freeze(missingCapabilities), assessment,
      confidence: confidenceFor(serverRecords, architecture), reason }));
  }

  const moduleCount = records.filter((record) => record?.kind === 'server').length;
  const byAssessment = createEmptyAssessmentCounts();
  const modulesByAssessment = createEmptyAssessmentCounts();
  const byArchitecture = Object.fromEntries(ARCHITECTURE_FAMILIES.map((family) => [family, {
    modules: 0, uniqueServers: 0, byAssessment: createEmptyAssessmentCounts(),
  }]));
  const architectureServerIds = Object.fromEntries(ARCHITECTURE_FAMILIES
    .map((family) => [family, new Set()]));
  for (const record of records) {
    if (record?.kind !== 'server' || typeof record.id !== 'string' || !record.id) continue;
    const family = ARCHITECTURE_FAMILIES.includes(record.architectureFamily)
      ? record.architectureFamily : 'UNKNOWN';
    byArchitecture[family].modules += 1;
    architectureServerIds[family].add(record.id);
  }
  const serverById = new Map(servers.map((item) => [item.server, item]));
  for (const family of ARCHITECTURE_FAMILIES) {
    byArchitecture[family].uniqueServers = architectureServerIds[family].size;
    for (const server of architectureServerIds[family]) {
      const item = serverById.get(server);
      if (item) byArchitecture[family].byAssessment[item.assessment] += 1;
    }
  }
  const blockers = new Map();
  for (const item of servers) {
    byAssessment[item.assessment] += 1;
    modulesByAssessment[item.assessment] += item.files;
    for (const capability of item.missingCapabilities) {
      blockers.set(capability, (blockers.get(capability) || 0) + 1);
    }
  }
  const blockingCapabilities = [...blockers.entries()]
    .map(([blockingCapability, affectedUniqueServers]) =>
      Object.freeze({ blockingCapability, affectedUniqueServers }))
    .sort((left, right) => right.affectedUniqueServers - left.affectedUniqueServers ||
      left.blockingCapability.localeCompare(right.blockingCapability));
  return deepFreeze({ runtimeCommit: RUNTIME_COMMIT, capabilityProfile: profile,
    summary: { modules: moduleCount, uniqueServers: servers.length, byAssessment,
      modulesByAssessment }, byArchitecture, blockingCapabilities, servers });
};

module.exports = {
  ASSESSMENTS,
  RUNTIME_COMMIT,
  capabilityAvailability,
  createArchitectureCoverageV2,
  createKanchitaCapabilityProfile,
  deriveRequiredCapabilities,
};
