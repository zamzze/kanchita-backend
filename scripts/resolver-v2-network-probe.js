'use strict';

const { parseNetworkProbeArgs, formatNetworkProbeJson, formatNetworkProbeText } =
  require('../src/modules/streams/resolverV2/diagnostics/networkProbeCli');

const main = async (argv = process.argv.slice(2)) => {
  const parsed = parseNetworkProbeArgs(argv);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.json ? '{"status":"invalid"}' : 'status=invalid'}\n`);
    process.exitCode = 2;
    return;
  }
  const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
  const { createRealNetworkProbe } =
    require('../src/modules/streams/resolverV2/diagnostics/realNetworkProbe');
  const runner = createRealNetworkProbe({
    httpClient: createSafeHttpClient({ timeoutMs: 15_000 }), timeoutMs: 15_000,
  });
  const results = parsed.all ? await runner.runAll() : [await runner.run(parsed.probe)];
  process.stdout.write(`${parsed.json
    ? formatNetworkProbeJson(results) : formatNetworkProbeText(results)}\n`);
  process.exitCode = results.some(({ status }) => status !== 'ready') ? 3 : 0;
};

if (require.main === module) main().catch(() => {
  process.stdout.write('status=failed\n');
  process.exitCode = 5;
});

module.exports = { main };
