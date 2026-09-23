'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanProviderMigrationManifest } = require(
  '../src/modules/streams/resolverV2/diagnostics/providerMigrationManifest');

const main = (args = process.argv.slice(2)) => {
  if (args.length !== 2 || args[0] !== '--balandro-path' || !args[1]) {
    process.stdout.write('status=INVALID_ARGUMENTS\n');
    process.exitCode = 2;
    return;
  }
  const result = scanProviderMigrationManifest({ root: args[1] });
  const root = path.resolve(__dirname, '..');
  fs.writeFileSync(path.join(root, 'balandro-provider-migration-manifest-v1.json'),
    `${JSON.stringify(result.manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'balandro-provider-migration-summary-v1.json'),
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
