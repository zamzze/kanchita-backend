'use strict';

const parseKodiTaxonomyArgs = (argv = []) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  const roots = []; let json = false; let coverage = false; let architecture = false;
  let architectureDetails = false;
  let architectureExplain = false;
  let architectureCoverageV2 = false;
  let channelCoverageV2 = false;
  const used = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      if (json) return { ok: false, json: true };
      json = true; continue;
    }
    if (item === '--coverage') {
      if (coverage) return { ok: false, json };
      coverage = true; continue;
    }
    if (item === '--architecture') {
      if (architecture) return { ok: false, json };
      architecture = true; continue;
    }
    if (item === '--architecture-details') {
      if (architectureDetails) return { ok: false, json };
      architectureDetails = true; continue;
    }
    if (item === '--architecture-explain') {
      if (architectureExplain) return { ok: false, json };
      architectureExplain = true; continue;
    }
    if (item === '--architecture-coverage-v2') {
      if (architectureCoverageV2) return { ok: false, json };
      architectureCoverageV2 = true; continue;
    }
    if (item === '--channel-coverage-v2') {
      if (channelCoverageV2) return { ok: false, json };
      channelCoverageV2 = true; continue;
    }
    if (!['--alfa-path', '--balandro-path'].includes(item) || used.has(item) ||
        index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      return { ok: false, json };
    }
    used.add(item);
    roots.push(argv[++index]);
  }
  if ((coverage && architecture) || (architectureDetails && !architecture) ||
      (architectureExplain && !architectureDetails) ||
      (architectureCoverageV2 && (!architecture || !architectureDetails)) ||
      (channelCoverageV2 && (coverage || architecture))) {
    return { ok: false, json };
  }
  return roots.length && (!channelCoverageV2 || roots.length === 1)
    ? { ok: true, json, coverage, ...(architecture ? { architecture: true } : {}),
      ...(architectureDetails ? { architectureDetails: true } : {}),
      ...(architectureExplain ? { architectureExplain: true } : {}),
      ...(architectureCoverageV2 ? { architectureCoverageV2: true } : {}),
      ...(channelCoverageV2 ? { channelCoverageV2: true } : {}), roots }
    : { ok: false, json };
};
const formatKodiTaxonomyJson = (result) => JSON.stringify(result);
const formatKodiTaxonomyText = (result) => {
  const lines = [
    `servers.total=${result.servers.total}`,
    `servers.active=${result.servers.active}`,
    ...Object.entries(result.servers)
      .filter(([key]) => !['total', 'active'].includes(key))
      .map(([key, value]) => `${key}=${value}`),
    `channels.total=${result.channels.total}`, `skipped=${result.skipped}`,
  ];
  for (const record of result.records) {
    lines.push(`${record.kind}=${record.id} classification=${record.classifications.join(',')} confidence=${record.confidence}${record.inactive ? ' inactive=true' : ''}`);
  }
  return lines.join('\n');
};

const coverageTaxonomySummary = (result) => Object.freeze({
  servers: result.servers,
  channels: result.channels,
  skipped: result.skipped,
});
const createCoverageOutput = (taxonomy, coverage, recommendation) => Object.freeze({
  taxonomy: coverageTaxonomySummary(taxonomy),
  coverage,
  recommendation,
});
const formatPercent = (value) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const formatKodiCoverageJson = (taxonomy, coverage, recommendation) =>
  JSON.stringify(createCoverageOutput(taxonomy, coverage, recommendation));
const formatKodiCoverageText = (taxonomy, coverage, recommendation) => [
  'Resolver V2 capability coverage',
  `servers.scanned=${coverage.totalScanned}`,
  `servers.eligible=${coverage.eligible}`,
  `servers.inactive=${coverage.inactive}`,
  `primary_compatible=${coverage.primaryCompatible}`,
  `resolution_only=${coverage.resolutionOnly}`,
  `requires_session=${coverage.requiresSession}`,
  `requires_javascript=${coverage.requiresJavascript}`,
  `requires_browser=${coverage.requiresBrowser}`,
  `protected=${coverage.protected}`,
  `unknown=${coverage.unknown}`,
  `primary_coverage=${formatPercent(coverage.coveragePercent)}`,
  `technical_coverage=${formatPercent(coverage.technicalCoveragePercent)}`,
  `largest_remaining_block=${recommendation.recommendedCapability}`,
  `affected_servers=${recommendation.affectedServers}`,
  'top_combinations:',
  ...coverage.topCombinations.map(({ signature, count }) => `${signature}=${count}`),
  `channels.total=${taxonomy.channels.total}`,
  `skipped=${taxonomy.skipped}`,
].join('\n');

const architecturePayload = (architecture, details, explanation) => {
  if (!details) return architecture;
  return Object.freeze({
    ...details,
    ...(explanation ? { unknownExplanation: explanation } : {}),
  });
};
const createArchitectureOutput = (taxonomy, architecture, details = null,
  explanation = null, coverageV2 = null) => Object.freeze({
  taxonomy: coverageTaxonomySummary(taxonomy),
  architecture: architecturePayload(architecture, details, explanation),
  ...(coverageV2 ? { coverageV2 } : {}),
});
const formatKodiArchitectureJson = (taxonomy, architecture, details = null,
  explanation = null, coverageV2 = null) =>
  JSON.stringify(createArchitectureOutput(taxonomy, architecture, details, explanation,
    coverageV2));
const formatKodiArchitectureText = (_taxonomy, architecture, details = null,
  explanation = null, coverageV2 = null) => {
  if (!details) {
    return [
      `architecture.total=${architecture.total}`,
      ...Object.entries(architecture)
        .filter(([key]) => key !== 'total')
        .map(([key, value]) => `${key}=${value}`),
    ].join('\n');
  }
  const lines = [
    `architecture.total=${details.counts.total}`,
    ...Object.entries(details.serversByArchitecture)
      .flatMap(([family, ids]) => [`${family}=${details.counts[family]}`, ...ids]),
  ];
  if (explanation) {
    for (const item of explanation) {
      lines.push('', `server=${item.server}`, `files=${item.files}`,
        `matchedSignals=${JSON.stringify(item.matchedSignals)}`,
        `observedSignals=${JSON.stringify(item.observedSignals)}`,
        `reason=${item.reason}`);
    }
  }
  if (coverageV2) {
    lines.push('', `coverageV2.runtimeCommit=${coverageV2.runtimeCommit}`,
      `coverageV2.modules=${coverageV2.summary.modules}`,
      `coverageV2.uniqueServers=${coverageV2.summary.uniqueServers}`);
    for (const [assessment, count] of Object.entries(coverageV2.summary.byAssessment)) {
      lines.push(`coverageV2.assessment.${assessment}=${count}`);
    }
    for (const [family, row] of Object.entries(coverageV2.byArchitecture)) {
      lines.push(`coverageV2.architecture.${family}.modules=${row.modules}`,
        `coverageV2.architecture.${family}.uniqueServers=${row.uniqueServers}`);
      for (const [assessment, count] of Object.entries(row.byAssessment)) {
        if (count > 0) lines.push(`coverageV2.architecture.${family}.${assessment}=${count}`);
      }
    }
    for (const blocker of coverageV2.blockingCapabilities) {
      lines.push(`coverageV2.blocker.${blocker.blockingCapability}=${blocker.affectedUniqueServers}`);
    }
    for (const item of coverageV2.servers) {
      lines.push('', `server=${item.server}`, `architecture=${item.architecture}`,
        `files=${item.files}`,
        `requiredCapabilities=${JSON.stringify(item.requiredCapabilities)}`,
        `availableCapabilities=${JSON.stringify(item.availableCapabilities)}`,
        `missingCapabilities=${JSON.stringify(item.missingCapabilities)}`,
        `assessment=${item.assessment}`, `confidence=${item.confidence}`,
        `reason=${item.reason}`);
    }
  }
  return lines.join('\n');
};

const createChannelCoverageV2Output = (coverage) => Object.freeze({
  channelCoverageV2: coverage,
});
const formatKodiChannelCoverageV2Json = (coverage) =>
  JSON.stringify(createChannelCoverageV2Output(coverage));
const formatKodiChannelCoverageV2Text = (coverage) => {
  const lines = [
    `channelCoverageV2.runtimeCommit=${coverage.runtimeCommit}`,
    `channelCoverageV2.topLevelFiles=${coverage.population.topLevelFiles}`,
    `channelCoverageV2.channels=${coverage.population.channels}`,
    `channelCoverageV2.emptyInitFiles=${coverage.population.emptyInitFiles}`,
  ];
  for (const [pattern, count] of Object.entries(coverage.summary.byPattern)) {
    lines.push(`channelCoverageV2.pattern.${pattern}=${count}`);
  }
  for (const [assessment, count] of Object.entries(coverage.summary.byAssessment)) {
    lines.push(`channelCoverageV2.assessment.${assessment}=${count}`);
  }
  for (const gap of coverage.summary.missingCapabilities) {
    lines.push(`channelCoverageV2.gap.${gap.missingCapability}=${gap.affectedChannels}`);
  }
  for (const item of coverage.channels) {
    lines.push('', `channel=${item.channel}`, `files=${item.files}`, `pattern=${item.pattern}`,
      `identitySignals=${JSON.stringify(item.identitySignals)}`,
      `catalogSignals=${JSON.stringify(item.catalogSignals)}`,
      `episodeSignals=${JSON.stringify(item.episodeSignals)}`,
      `sourceSignals=${JSON.stringify(item.sourceSignals)}`,
      `requiredCapabilities=${JSON.stringify(item.requiredCapabilities)}`,
      `missingCapabilities=${JSON.stringify(item.missingCapabilities)}`,
      `assessment=${item.assessment}`, `confidence=${item.confidence}`,
      `reason=${item.reason}`);
  }
  return lines.join('\n');
};

module.exports = {
  createArchitectureOutput,
  createChannelCoverageV2Output,
  createCoverageOutput,
  formatKodiArchitectureJson,
  formatKodiArchitectureText,
  formatKodiChannelCoverageV2Json,
  formatKodiChannelCoverageV2Text,
  formatKodiCoverageJson,
  formatKodiCoverageText,
  formatKodiTaxonomyJson,
  formatKodiTaxonomyText,
  parseKodiTaxonomyArgs,
};
