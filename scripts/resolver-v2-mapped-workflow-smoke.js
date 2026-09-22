'use strict';

const {
  createMappedWorkflowSmoke,
  formatMappedWorkflowSmoke,
  parseMappedWorkflowSmokeArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/mappedWorkflowSmoke');

const main = async (argv = process.argv.slice(2)) => {
  const parsed = parseMappedWorkflowSmokeArgs(argv);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.json ? '{"status":"INVALID_ARGUMENTS"}'
      : 'status=INVALID_ARGUMENTS'}\n`);
    process.exitCode = 2;
    return;
  }
  const { createSafeHttpClient } = require(
    '../src/modules/streams/http/safeHttpClient');
  const runner = createMappedWorkflowSmoke({
    httpClient: createSafeHttpClient({ timeoutMs: 10_000 }), timeoutMs: 10_000,
  });
  const result = await runner.run(parsed);
  process.stdout.write(`${formatMappedWorkflowSmoke(result, parsed.json)}\n`);
  process.exitCode = result.status === 'RESOLUTION_READY' ? 0 : 3;
};

if (require.main === module) main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'UNEXPECTED_FAILURE';
  process.stdout.write(`status=RESOLUTION_FAILED\nerrorCode=${code}\n`);
  process.exitCode = 5;
});

module.exports = { main };
