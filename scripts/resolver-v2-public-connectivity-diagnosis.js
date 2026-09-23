'use strict';

const { createPublicConnectivityDiagnosis, formatPublicConnectivityDiagnosis } = require(
  '../src/modules/streams/resolverV2/diagnostics/publicConnectivityDiagnosis');

const main = async (args = process.argv.slice(2)) => {
  if (args.length > 1 || args.length === 1 && args[0] !== '--json') {
    process.stdout.write('status=INVALID_ARGUMENTS\n');
    process.exitCode = 2;
    return;
  }
  const result = await createPublicConnectivityDiagnosis().run();
  process.stdout.write(`${formatPublicConnectivityDiagnosis(result, args[0] === '--json')}\n`);
  process.exitCode = result.rootCauseCode === 'CONNECTIVITY_OK' ? 0 : 3;
};

if (require.main === module) main().catch(() => {
  process.stdout.write('status=CONNECTIVITY_DIAGNOSIS_FAILED\n');
  process.exitCode = 5;
});

module.exports = { main };
