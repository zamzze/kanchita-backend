'use strict';

const { parseMappedCatalogArgs, createMappedCatalogIngester } =
  require('../src/ingestion/mappedCatalogIngester');

const main = async (args = process.argv.slice(2)) => {
  const options = parseMappedCatalogArgs(args);
  if (!process.env.DB_URL) throw Object.assign(new Error('MAPPED_CATALOG_DB_URL_MISSING'),
    { code: 'MAPPED_CATALOG_DB_URL_MISSING' });
  const { Pool } = require('pg');
  const { createCatalogSeedStore } = require('../src/db/catalogSeed.queries');
  const { getMovieDetail, getSeriesDetail } = require('../src/ingestion/tmdb/tmdbFetcher');
  const pool = new Pool({ connectionString: process.env.DB_URL });
  try {
    const ingester = createMappedCatalogIngester({
      store: createCatalogSeedStore(pool), fetchMovie: getMovieDetail,
      fetchSeries: getSeriesDetail,
    });
    const result = await ingester.run(options);
    process.stdout.write(`Mapped catalog provider=${options.providerId} ` +
      `requested=${result.requested} alreadyPresent=${result.alreadyPresent} ` +
      `inserted=${result.inserted} updated=${result.updated} ` +
      `notFound=${result.notFound} failed=${result.failed}\n`);
    return result;
  } finally { await pool.end(); }
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'MAPPED_CATALOG_ERROR'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
