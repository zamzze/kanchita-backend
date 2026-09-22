'use strict';

const { parseKodiTaxonomyArgs, formatKodiArchitectureJson, formatKodiArchitectureText,
  formatKodiCoverageJson, formatKodiCoverageText,
  formatKodiTaxonomyJson, formatKodiTaxonomyText } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const main = (argv = process.argv.slice(2)) => {
  const parsed = parseKodiTaxonomyArgs(argv);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.json ? '{"status":"invalid"}' : 'status=invalid'}\n`);
    process.exitCode = 2;
    return;
  }
  const { scanKodiTaxonomy } =
    require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner');
  try {
    const result = scanKodiTaxonomy({ roots: parsed.roots,
      architecture: parsed.architecture,
      architectureExplain: parsed.architectureExplain === true });
    if (parsed.architecture) {
      const { createArchitectureDetails, createArchitectureSummary,
        createUnknownArchitectureExplanation } =
        require('../src/modules/streams/resolverV2/diagnostics/kodiArchitecture');
      const architecture = createArchitectureSummary(result.records);
      const details = parsed.architectureDetails
        ? createArchitectureDetails(result.records) : null;
      const explanation = parsed.architectureExplain
        ? createUnknownArchitectureExplanation(result.records) : null;
      process.stdout.write(`${parsed.json
        ? formatKodiArchitectureJson(result, architecture, details, explanation)
        : formatKodiArchitectureText(result, architecture, details, explanation)}\n`);
    } else if (parsed.coverage) {
      const { createCoverageSummary, recommendNextCapability } =
        require('../src/modules/streams/resolverV2/diagnostics/capabilityCoverage');
      const coverage = createCoverageSummary(result.records);
      const recommendation = recommendNextCapability(coverage);
      process.stdout.write(`${parsed.json
        ? formatKodiCoverageJson(result, coverage, recommendation)
        : formatKodiCoverageText(result, coverage, recommendation)}\n`);
    } else {
      process.stdout.write(`${parsed.json
        ? formatKodiTaxonomyJson(result) : formatKodiTaxonomyText(result)}\n`);
    }
    process.exitCode = 0;
  } catch {
    process.stdout.write(`${parsed.json ? '{"status":"failed"}' : 'status=failed'}\n`);
    process.exitCode = 5;
  }
};

if (require.main === module) main();

module.exports = { main };
