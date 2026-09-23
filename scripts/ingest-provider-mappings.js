'use strict';

const { createMappingRegistry } =
  require('../src/ingestion/mappings/mappingRegistry');
const { createBulkMappingWorker, formatMappingProgress } =
  require('../src/ingestion/mappings/bulkMappingWorker');
const { ID } = require('../src/ingestion/mappings/mappingContract');
const { uuid } = require('../src/db/bulkPersistence.validation');

const invalid = () => Object.assign(new Error('BULK_MAPPING_CLI_INVALID_ARGS'),
  { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
const number = (value, max) => /^[1-9]\d*$/.test(value || '') &&
  Number.isSafeInteger(Number(value)) && Number(value) <= max ? Number(value) : null;

const parseArgs = (args) => {
  if (!Array.isArray(args)) throw invalid();
  const values = {};
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (!['--limit', '--providers', '--target-mappings', '--workers',
      '--batch-size', '--resume'].includes(name) || Object.hasOwn(values, name) ||
      index + 1 >= args.length || args[index + 1].startsWith('--')) throw invalid();
    values[name] = args[++index];
  }
  if (values['--resume']) {
    if (dryRun || Object.keys(values).length !== 1 ||
        !uuid(values['--resume'])) throw invalid();
    return Object.freeze({ resume: values['--resume'] });
  }
  const providers = values['--providers'] === undefined ? null :
    values['--providers'].split(',');
  if (providers && (!providers.length || providers.some((id) => !ID.test(id)) ||
      new Set(providers).size !== providers.length)) throw invalid();
  const numeric = [
    ['--limit', 'limit', 100_000],
    ['--target-mappings', 'targetMappings', 32],
    ['--workers', 'workers', 8],
    ['--batch-size', 'batchSize', 100],
  ];
  const output = { dryRun, providers };
  for (const [flag, field, max] of numeric) {
    if (values[flag] === undefined) continue;
    const parsed = number(values[flag], max);
    if (!parsed) throw invalid();
    output[field] = parsed;
  }
  return Object.freeze(output);
};

const createCliRegistry = () => createMappingRegistry([{
  id: 'pluto', enabled: true, priority: 0,
  supportsMovies: true, supportsSeries: true, region: 'latam',
  maxConcurrent: 1, minDelayMs: 0,
  // Existing Pluto mappings count toward the target. No discovery is performed here.
  discoverMapping: async () => [],
}]);

const main = async (args = process.argv.slice(2)) => {
  const options = parseArgs(args);
  if (!process.env.DB_URL) throw Object.assign(new Error('BULK_MAPPING_DB_URL_MISSING'),
    { code: 'BULK_MAPPING_DB_URL_MISSING' });
  const { Pool } = require('pg');
  const { createBulkMappingStore } = require('../src/db/bulkMapping.queries');
  const { createIngestionRunStore } = require('../src/db/ingestionRuns.queries');
  const { createProviderMediaMappingStore } =
    require('../src/db/providerMediaMappings.queries');
  const pool = new Pool({ connectionString: process.env.DB_URL,
    max: Math.max(4, (options.workers || 2) + 2) });
  let worker;
  const stop = () => worker?.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    worker = createBulkMappingWorker({ registry: createCliRegistry(),
      bulkStore: createBulkMappingStore(pool),
      runStore: createIngestionRunStore(pool),
      mappingStore: createProviderMediaMappingStore(pool),
      logger: (message) => process.stdout.write(`${message}\n`),
    });
    const result = await worker.run(options);
    process.stdout.write(`${formatMappingProgress({ progress: result.progress,
      runId: result.runId, startedAt: Date.now() - result.elapsedMs,
      now: Date.now() })}\n`);
    return result;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'BULK_MAPPING_ERROR'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, createCliRegistry };
