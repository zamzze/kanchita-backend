'use strict';

const { parseKodiTaxonomyArgs, formatKodiCoverageJson, formatKodiCoverageText,
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
    const result = scanKodiTaxonomy({ roots: parsed.roots });
    if (parsed.coverage) {
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
