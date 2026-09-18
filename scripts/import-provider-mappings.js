'use strict';

const fs = require('node:fs/promises');
const { Pool } = require('pg');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { applyImport, prepareImport } =
  require('../src/modules/streams/providerMediaMappingImport');

const parseArgs = (argv) => {
  const options = { providerId: null, region: null, file: null, apply: false };
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run' || flag === '--apply') {
      if (mode && mode !== flag) return null;
      mode = flag;
      options.apply = flag === '--apply';
      continue;
    }
    if (!['--provider', '--region', '--file'].includes(flag) || !argv[index + 1]) return null;
    const key = flag === '--provider' ? 'providerId' : flag.slice(2);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (options.providerId !== 'pluto' || options.region !== 'latam' || !options.file) return null;
  return Object.freeze(options);
};

const run = async (options, { readFile = fs.readFile, poolFactory } = {}) => {
  const payload = JSON.parse(await readFile(options.file, 'utf8'));
  const prepared = prepareImport(payload, options);
  if (!options.apply) return applyImport({ prepared, dryRun: true });
  if (!process.env.DB_URL) throw new Error('Missing DB_URL for --apply');
  const pool = poolFactory ? poolFactory(process.env.DB_URL)
    : new Pool({ connectionString: process.env.DB_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const summary = await applyImport({ prepared,
      store: createProviderMediaMappingStore(client), dryRun: false });
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options) throw new Error(
    'Usage: --provider pluto --region latam --file <json> [--dry-run|--apply]'
  );
  console.log(JSON.stringify(await run(options)));
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
