'use strict';

const parseKodiTaxonomyArgs = (argv = []) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  const roots = []; let json = false; let coverage = false; const used = new Set();
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
    if (!['--alfa-path', '--balandro-path'].includes(item) || used.has(item) ||
        index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      return { ok: false, json };
    }
    used.add(item);
    roots.push(argv[++index]);
  }
  return roots.length ? { ok: true, json, coverage, roots } : { ok: false, json };
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

module.exports = {
  createCoverageOutput,
  formatKodiCoverageJson,
  formatKodiCoverageText,
  formatKodiTaxonomyJson,
  formatKodiTaxonomyText,
  parseKodiTaxonomyArgs,
};
