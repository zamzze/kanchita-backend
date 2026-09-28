'use strict';

const { createMappingRegistry } =
  require('../src/ingestion/mappings/mappingRegistry');
const { createBulkMappingWorker, formatMappingProgress } =
  require('../src/ingestion/mappings/bulkMappingWorker');
const { ID } = require('../src/ingestion/mappings/mappingContract');
const { uuid } = require('../src/db/bulkPersistence.validation');
const { createHtmlEpisodeMappingProvider } =
  require('../src/ingestion/mappings/htmlEpisodeMappingProvider');

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
      '--batch-size', '--resume', '--html-episode-config',
      '--series-tmdb-id'].includes(name) || Object.hasOwn(values, name) ||
      index + 1 >= args.length || args[index + 1].startsWith('--')) throw invalid();
    values[name] = args[++index];
  }
  if (values['--resume']) {
    if (dryRun || Object.keys(values).some((key) =>
      !['--resume', '--html-episode-config'].includes(key)) ||
        !uuid(values['--resume'])) throw invalid();
    return Object.freeze({ resume: values['--resume'],
      ...(values['--html-episode-config']
        ? { htmlEpisodeConfigPath: values['--html-episode-config'] } : {}) });
  }
  const htmlEpisodeConfigPath = values['--html-episode-config'];
  if (values['--series-tmdb-id'] && !htmlEpisodeConfigPath ||
      htmlEpisodeConfigPath && !values['--series-tmdb-id'] && !values['--limit'] ||
      htmlEpisodeConfigPath && (values['--providers'] || values['--target-mappings'])) {
    throw invalid();
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
    ['--series-tmdb-id', 'tmdbId', 2_147_483_647],
  ];
  const output = { dryRun, providers,
    ...(htmlEpisodeConfigPath ? { mode: 'series_episodes', htmlEpisodeConfigPath } : {}) };
  for (const [flag, field, max] of numeric) {
    if (values[flag] === undefined) continue;
    const parsed = number(values[flag], max);
    if (!parsed) throw invalid();
    output[field] = parsed;
  }
  return Object.freeze(output);
};

const createCliRegistry = ({ htmlEpisodeConfig, mappingStore, http } = {}) =>
  createMappingRegistry([{
  id: 'pluto', enabled: true, priority: 0,
  supportsMovies: true, supportsSeries: true, region: 'latam',
  maxConcurrent: 1, minDelayMs: 0,
  // Existing Pluto mappings count toward the target. No discovery is performed here.
  discoverMapping: async () => [],
}, ...(htmlEpisodeConfig ? [createHtmlEpisodeMappingProvider({
    ...htmlEpisodeConfig, mappingStore, http,
  })] : [])]);

const main = async (args = process.argv.slice(2),
  { httpClient = null, now = Date.now } = {}) => {
  const options = parseArgs(args);
  if (httpClient && typeof httpClient.request !== 'function' ||
      typeof now !== 'function') throw invalid();
  const { htmlEpisodeConfigPath, ...workerOptions } = options;
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
    const mappingStore = createProviderMediaMappingStore(pool);
    let htmlEpisodeConfig = null;
    if (htmlEpisodeConfigPath) {
      const { readFileSync } = require('node:fs');
      const parsed = JSON.parse(readFileSync(htmlEpisodeConfigPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.keys(parsed).some((key) => ![
            'id', 'region', 'baseUrl', 'seriesPathTemplate', 'maxSeasons',
            'maxEpisodesPerSeason', 'timeoutMs'].includes(key))) throw invalid();
      htmlEpisodeConfig = parsed;
      if (workerOptions.mode === 'series_episodes') {
        workerOptions.providers = [parsed.id];
      }
    }
    const http = htmlEpisodeConfig
      ? httpClient || require('../src/modules/streams/http/safeHttpClient')
        .createSafeHttpClient() : null;
    worker = createBulkMappingWorker({ registry: createCliRegistry({
      htmlEpisodeConfig, mappingStore, http,
    }),
      bulkStore: createBulkMappingStore(pool),
      runStore: createIngestionRunStore(pool),
      mappingStore,
      logger: (message) => process.stdout.write(`${message}\n`),
      now,
    });
    const result = await worker.run(workerOptions);
    process.stdout.write(`${formatMappingProgress({ progress: result.progress,
      runId: result.runId, startedAt: Date.now() - result.elapsedMs,
      now: Date.now() })}\n`);
    if (htmlEpisodeConfig) process.stdout.write(
      `Mappings this invocation: inserted=${result.mappingChanges.inserted} ` +
      `updated=${result.mappingChanges.updated} ` +
      `unchanged=${result.mappingChanges.unchanged} ` +
      `failed=${result.mappingChanges.failed}\n`);
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
