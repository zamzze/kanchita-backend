'use strict';

const { parseCatalogArgs, createCatalogSeeder } = require('../src/ingestion/catalogSeeder');

const formatProgress = ({ runId, progress, targets, stats, dryRun }) => {
  const total = progress.movie + progress.series;
  const target = targets.movie + targets.series;
  return `Catalog seed${dryRun ? ' (dry run)' : ''}\n` +
    `Movies: ${progress.movie} / ${targets.movie}\n` +
    `Series: ${progress.series} / ${targets.series}\n` +
    `Total: ${total} / ${target}\n` +
    `Inserted: ${stats.inserted} Updated: ${stats.updated} ` +
    `Unchanged: ${stats.unchanged} Failed: ${stats.failed}\n` +
    `Run: ${runId || 'none'}`;
};

const main = async (args = process.argv.slice(2)) => {
  const options = parseCatalogArgs(args);
  const { discoverCatalogPage } = require('../src/ingestion/tmdb/tmdbFetcher');
  let pool;
  try {
    let store = null;
    if (!options.dryRun) {
      if (!process.env.DB_URL) throw Object.assign(new Error('CATALOG_DB_URL_MISSING'),
        { code: 'CATALOG_DB_URL_MISSING' });
      const { Pool } = require('pg');
      const { createCatalogSeedStore } = require('../src/db/catalogSeed.queries');
      pool = new Pool({ connectionString: process.env.DB_URL });
      store = createCatalogSeedStore(pool);
    }
    const seed = createCatalogSeeder({ fetchPage: discoverCatalogPage, store,
      logger: (event) => {
        const { cursor } = event;
        if (cursor.offset === 0 || cursor.done) {
          process.stdout.write(`${formatProgress(event)}\n`);
        }
      } });
    const result = await seed.run(options);
    process.stdout.write(`${formatProgress({ runId: result.runId,
      progress: result.checkpoint.progress,
      targets: options.config?.targets || (await store.getRun(result.runId)).config_json.targets,
      stats: result.checkpoint.stats, dryRun: result.dryRun })}\n`);
    return result;
  } finally {
    if (pool) await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'CATALOG_SEED_ERROR'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, formatProgress };
