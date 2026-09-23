'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanMinimumCapabilityBundles } = require(
  '../src/modules/streams/resolverV2/diagnostics/minimumCapabilityBundles');

const main = (args = process.argv.slice(2)) => {
  if (args.length !== 2 || args[0] !== '--balandro-path' || !args[1]) {
    process.stdout.write('status=INVALID_ARGUMENTS\n');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(__dirname, '..');
  const result = scanMinimumCapabilityBundles({ root: args[1],
    manifestPath: path.join(root, 'balandro-provider-migration-manifest-v1.json') });
  fs.writeFileSync(path.join(root, 'balandro-minimum-capability-bundles-v1.json'),
    `${JSON.stringify(result.profiles, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'balandro-minimum-capability-bundles-summary-v1.json'),
    `${JSON.stringify(result.summary, null, 2)}\n`);
  process.stdout.write(`status=OK\ntotalUniqueModules=${result.summary.totalUniqueModules}\n`);
};

if (require.main === module) {
  try { main(); } catch {
    process.stdout.write('status=SCAN_FAILED\n');
    process.exitCode = 1;
  }
}

module.exports = { main };
