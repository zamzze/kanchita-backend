'use strict';

const { parseKodiTaxonomyArgs, formatKodiArchitectureJson, formatKodiArchitectureText,
  formatKodiChannelCapabilityPayoffJson, formatKodiChannelCapabilityPayoffText,
  formatKodiChannelCoverageV2Json, formatKodiChannelCoverageV2Text,
  formatKodiChannelRegexGapJson, formatKodiChannelRegexGapText,
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
  try {
    if (parsed.channelCapabilityPayoff) {
      const { scanChannelCapabilityPayoff } =
        require('../src/modules/streams/resolverV2/diagnostics/kodiChannelCapabilityPayoff');
      const payoff = scanChannelCapabilityPayoff({ root: parsed.roots[0] });
      process.stdout.write(`${parsed.json
        ? formatKodiChannelCapabilityPayoffJson(payoff)
        : formatKodiChannelCapabilityPayoffText(payoff)}\n`);
      process.exitCode = 0;
      return;
    }
    if (parsed.channelCoverageV2) {
      const { scanTopLevelChannelCoverageV2 } =
        require('../src/modules/streams/resolverV2/diagnostics/kodiChannelCoverageV2');
      const coverage = scanTopLevelChannelCoverageV2({ root: parsed.roots[0] });
      if (parsed.channelRegexGap) {
        const { scanChannelRegexGap } =
          require('../src/modules/streams/resolverV2/diagnostics/kodiChannelRegexGap');
        const gap = scanChannelRegexGap({ root: parsed.roots[0], coverage });
        process.stdout.write(`${parsed.json
          ? formatKodiChannelRegexGapJson(gap)
          : formatKodiChannelRegexGapText(gap)}\n`);
        process.exitCode = 0;
        return;
      }
      process.stdout.write(`${parsed.json
        ? formatKodiChannelCoverageV2Json(coverage)
        : formatKodiChannelCoverageV2Text(coverage)}\n`);
      process.exitCode = 0;
      return;
    }
    const { scanKodiTaxonomy } =
      require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner');
    const result = scanKodiTaxonomy({ roots: parsed.roots,
      architecture: parsed.architecture,
      architectureExplain: parsed.architectureExplain === true ||
        parsed.architectureCoverageV2 === true });
    if (parsed.architecture) {
      const { createArchitectureDetails, createArchitectureSummary,
        createUnknownArchitectureExplanation } =
        require('../src/modules/streams/resolverV2/diagnostics/kodiArchitecture');
      const architecture = createArchitectureSummary(result.records);
      const details = parsed.architectureDetails
        ? createArchitectureDetails(result.records) : null;
      const explanation = parsed.architectureExplain
        ? createUnknownArchitectureExplanation(result.records) : null;
      const coverageV2 = parsed.architectureCoverageV2
        ? require('../src/modules/streams/resolverV2/diagnostics/kodiArchitectureCoverageV2')
          .createArchitectureCoverageV2(result.records)
        : null;
      process.stdout.write(`${parsed.json
        ? formatKodiArchitectureJson(result, architecture, details, explanation, coverageV2)
        : formatKodiArchitectureText(result, architecture, details, explanation, coverageV2)}\n`);
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
