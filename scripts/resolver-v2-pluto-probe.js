'use strict';

const { createPlutoProbe, formatJson, formatText, parseArgs } =
  require('../src/modules/streams/resolverV2/diagnostics/plutoProbeCli');

const main = async (argv = process.argv.slice(2)) => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.json ? '{"status":"invalid"}' : 'status=invalid'}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await createPlutoProbe().run(parsed.value);
  process.stdout.write(`${parsed.json ? formatJson(result) : formatText(result)}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 3;
};

if (require.main === module) main().catch(() => {
  process.stdout.write('status=failed\n');
  process.exitCode = 5;
});

module.exports = { main };
