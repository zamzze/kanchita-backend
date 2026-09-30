'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSourceCatalogStore } = require('../../db/sourceCatalog.queries');

const PROVIDER_ID = process.env.TUTORIAL_SOURCE_PROVIDER || 'tutorial_catalog';
const BATCH_SIZE = Math.max(1, Number.parseInt(process.env.TUTORIAL_IMPORT_BATCH_SIZE || '250', 10));

const inputArg = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]);
const dryRun = process.argv.includes('--dry-run');

const allowedStatuses = new Set([
  'ok',
  'no_servers',
  'not_found_404',
  'http_error',
  'network_error',
  'unexpected_content_type',
]);

const parseInput = (filePath) => {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.records)) {
    throw new Error('Input must contain a records array');
  }
  return parsed.records;
};

const validateServer = (server) => {
  if (!server?.valid || !server.iframeUrl) return null;

  let url;
  try {
    url = new URL(server.iframeUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return null;

  return {
    server_index: Number.isInteger(server.ordinal) && server.ordinal > 0
      ? server.ordinal
      : 1,
    iframe_url: url.toString(),
    iframe_host: url.hostname || null,
  };
};

const normalizeRecord = (record) => {
  if (!record?.tutorialUrl || !record?.status || !allowedStatuses.has(record.status)) {
    return null;
  }

  const servers = (record.servers || [])
    .map(validateServer)
    .filter(Boolean);

  return {
    provider_id: PROVIDER_ID,
    tutorial_url: record.tutorialUrl,
    request_url_used: record.requestUrlUsed || record.tutorialUrl,
    fetch_status: record.status,
    server_count: servers.length,
    servers,
  };
};

const importBatch = async (client, store, records) => {
  let importedItems = 0;
  let importedServers = 0;

  await client.query('BEGIN');
  try {
    for (const item of records) {
      const row = await store.upsertItemWithClient(client, item);
      await store.deactivateServersWithClient(client, row.id);

      for (const server of item.servers) {
        await store.upsertServerWithClient(client, {
          catalog_item_id: row.id,
          ...server,
        });
        importedServers += 1;
      }

      importedItems += 1;
    }

    await client.query('COMMIT');
    return { importedItems, importedServers };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

const main = async () => {
  if (!inputArg) {
    throw new Error(
      'Usage: npm run import:tutorial-sources -- <tutorial-server-extraction-latest.json> [--dry-run]'
    );
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const rawRecords = parseInput(inputPath);
  const records = rawRecords.map(normalizeRecord).filter(Boolean);

  const sourceServerCount = records.reduce((sum, item) => sum + item.servers.length, 0);
  const statusCounts = records.reduce((acc, item) => {
    acc[item.fetch_status] = (acc[item.fetch_status] || 0) + 1;
    return acc;
  }, {});

  console.log('[TutorialSources] Input audit');
  console.log(`  raw records     : ${rawRecords.length}`);
  console.log(`  accepted records: ${records.length}`);
  console.log(`  valid servers   : ${sourceServerCount}`);
  console.log(`  provider        : ${PROVIDER_ID}`);
  console.log(`  statuses        : ${JSON.stringify(statusCounts)}`);
  console.log(`  dry run         : ${dryRun}`);

  if (dryRun) {
    return;
  }

  const client = await pool.connect();
  const store = createSourceCatalogStore(pool);

  let importedItems = 0;
  let importedServers = 0;

  try {
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      const batch = records.slice(offset, offset + BATCH_SIZE);
      const result = await importBatch(client, store, batch);
      importedItems += result.importedItems;
      importedServers += result.importedServers;

      const done = Math.min(offset + batch.length, records.length);
      console.log(
        `[TutorialSources] ${done}/${records.length} items | ` +
        `servers=${importedServers}`
      );
    }

    const summary = await store.getImportSummary();

    console.log('[TutorialSources] Import complete');
    console.log(`  imported items : ${importedItems}`);
    console.log(`  imported servers: ${importedServers}`);
    console.log(`  db items       : ${summary.items}`);
    console.log(`  db ok          : ${summary.ok_items}`);
    console.log(`  db no_servers  : ${summary.no_server_items}`);
    console.log(`  db not_found   : ${summary.not_found_items}`);
    console.log(`  db unmapped    : ${summary.unmapped_items}`);
    console.log(`  active servers : ${summary.active_servers}`);
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch(async (error) => {
  console.error(`[TutorialSources] ${error.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
