'use strict';

const { createCatalogProviderSmoke, formatCatalogProviderSmoke,
  parseCatalogProviderSmokeArgs } = require(
  '../src/modules/streams/resolverV2/diagnostics/catalogProviderSmoke');

const main = async (argv = process.argv.slice(2)) => {
  const parsed = parseCatalogProviderSmokeArgs(argv);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.json ? '{"status":"INVALID_ARGUMENTS"}'
      : 'status=INVALID_ARGUMENTS'}\n`);
    process.exitCode = 2;
    return;
  }
  const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
  const result = await createCatalogProviderSmoke({
    httpClient: createSafeHttpClient({ timeoutMs: 12_000, maxRedirects: 2 }),
  }).run(parsed);
  process.stdout.write(`${formatCatalogProviderSmoke(result, parsed.json)}\n`);
  process.exitCode = result.status === 'RESOLUTION_READY' ? 0 : 3;
};

if (require.main === module) main().catch(() => {
  process.stdout.write('status=RESOLUTION_FAILED\nerrorCode=UNKNOWN_ERROR\n');
  process.exitCode = 5;
});

module.exports = { main };
