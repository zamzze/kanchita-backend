'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createBulkMappingStore } = require('../src/db/bulkMapping.queries');
const { createIngestionRunStore } = require('../src/db/ingestionRuns.queries');
const { createProviderMediaMappingStore } =
  require('../src/db/providerMediaMappings.queries');
const { createProviderMediaMappingResolver } =
  require('../src/modules/streams/providerMediaMappingResolver');
const { createMappingRegistry } =
  require('../src/ingestion/mappings/mappingRegistry');
const { createBulkMappingWorker } =
  require('../src/ingestion/mappings/bulkMappingWorker');
const { createHtmlEpisodeMappingProvider } =
  require('../src/ingestion/mappings/htmlEpisodeMappingProvider');
const { createHttpWorkflowSourceProvider } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { createMappedSourceProviderAdapter } =
  require('../src/modules/streams/resolverV2/providers/mappedSourceProviderAdapter');
const { createSourceProviderRegistry } =
  require('../src/modules/streams/resolverV2/sourceProviderRegistry');
const { createSourceProviderManager } =
  require('../src/modules/streams/resolverV2/sourceProviderManager');
const { main, parseArgs } = require('../scripts/ingest-provider-mappings');

const ID = 'html_fixture';
const encoded = (url) => Buffer.from(url, 'utf8').toString('base64');
const leafWorkflow = [
  { type: 'request', method: 'GET', path: '{externalId}', saveAs: 'detail' },
  { type: 'extractMany', from: 'detail', parser: 'html', selector: 'li[data-source]',
    fields: { source: 'data-source', language: 'data-language',
      variant: 'data-variant' }, saveAs: 'options' },
  { type: 'decodeBase64Many', from: 'options', field: 'source',
    targetField: 'url', saveAs: 'decoded' },
  { type: 'filterMany', from: 'decoded', field: 'url',
    urlProtocol: 'https', saveAs: 'secure' },
  { type: 'emitEach', from: 'secure', url: '{item.url}',
    languageHint: '{item.language}', metadataFields: { variant: 'variant' } },
];

const fixture = async (t) => {
  let failSeasonTwo = true;
  const requests = [];
  const pages = {
    '/serie/show-1': '<a data-season="2" data-href="/temporada/s2"></a>' +
      '<a data-season="1" data-href="/temporada/s1"></a>' +
      '<a data-season="1" data-href="/temporada/s1"></a>',
    '/temporada/s1': '<a data-episode="3" data-href="/episodio/s1e3"></a>' +
      '<a data-episode="1" data-href="/episodio/s1e1"></a>',
    '/temporada/s2': '<a data-episode="3" data-href="/episodio/s2e3"></a>' +
      '<a data-episode="3" data-href="/episodio/s2e3"></a>',
    '/episodio/s2e3': `<li data-source="${encoded('https://media.example.test/e3.m3u8')}" ` +
      'data-language="es-419" data-variant="1"></li>',
  };
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/temporada/s2' && failSeasonTwo) {
      response.writeHead(503).end();
      return;
    }
    if (!Object.hasOwn(pages, request.url)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' }).end(pages[request.url]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests,
    recover: () => { failSeasonTwo = false; },
    fail: () => { failSeasonTwo = true; } };
};

test('CLI keeps HTML episode mode opt-in and bounded', () => {
  const manual = parseArgs(['--html-episode-config', 'local.json',
    '--series-tmdb-id', '900']);
  assert.equal(manual.mode, 'series_episodes');
  assert.equal(manual.tmdbId, 900);
  assert.deepEqual(parseArgs(['--resume', '00000000-0000-4000-8000-000000000001',
    '--html-episode-config', 'local.json']), {
    resume: '00000000-0000-4000-8000-000000000001',
    htmlEpisodeConfigPath: 'local.json',
  });
  assert.throws(() => parseArgs(['--html-episode-config', 'local.json']),
    { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
  assert.throws(() => parseArgs(['--series-tmdb-id', '900']),
    { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
  assert.throws(() => parseArgs(['--html-episode-config', 'local.json',
    '--limit', '2', '--providers', 'pluto']),
  { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
  assert.throws(() => parseArgs(['--html-episode-config', 'local.json',
    '--limit', '2', '--target-mappings', '2']),
  { code: 'BULK_MAPPING_CLI_INVALID_ARGS' });
});

test('PostgreSQL manual run, retry/resume, idempotence and exact leaf playback',
  { skip: process.env.TEST_DB_URL ? false : 'Set TEST_DB_URL for PostgreSQL integration' },
  async (t) => {
    const target = new URL(process.env.TEST_DB_URL);
    assert.equal(decodeURIComponent(target.pathname.slice(1)),
      'kanchita_resolver_v2_test');
    const schema = `kanchita_html_episode_${randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
    const db = new Pool({ connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${schema},public` });
    const local = await fixture(t);
    try {
      assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name,
        'kanchita_resolver_v2_test');
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations({ pool: db, logger: { log() {} } });
      const { rows } = await db.query(`INSERT INTO series (tmdb_id,title)
        VALUES (900,'Fixture series'),(901,'Other series') RETURNING id,tmdb_id`);
      const seriesId = rows.find((row) => row.tmdb_id === 900).id;
      const mappingStore = createProviderMediaMappingStore(db);
      await mappingStore.upsertMapping({ providerId: ID, region: 'global',
        contentType: 'series', tmdbId: 900, externalId: 'show-1' });
      const httpClient = createSafeHttpClient({ allowPrivateNetworks: true });
      const provider = createHtmlEpisodeMappingProvider({ id: ID, region: 'global',
        baseUrl: local.baseUrl, seriesPathTemplate: '/serie/{externalId}',
        http: httpClient, mappingStore });
      const registry = createMappingRegistry([provider]);
      const bulkStore = createBulkMappingStore(db);
      const runStore = createIngestionRunStore(db);
      const logs = [];
      const worker = () => createBulkMappingWorker({ registry, bulkStore,
        runStore, mappingStore, logger: (message) => logs.push(message),
        now: () => Date.parse('2025-01-01T00:00:00Z') });
      const options = { mode: 'series_episodes', tmdbId: 900,
        providers: [ID], workers: 1, batchSize: 1, targetMappings: 1 };
      const failed = await worker().run(options);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.progress.failed, 1);
      assert.equal(failed.mappingChanges.failed, 1);
      assert.deepEqual(local.requests,
        ['/serie/show-1', '/temporada/s2']);
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS count FROM
        provider_media_mappings WHERE content_type='episode'`)).rows[0].count, 0);
      local.recover();
      const resumed = await worker().run({ resume: failed.runId });
      assert.equal(resumed.runId, failed.runId);
      assert.equal(resumed.status, 'completed');
      assert.deepEqual(resumed.mappingChanges,
        { inserted: 3, updated: 0, unchanged: 0, failed: 0 });
      assert.equal(resumed.progress.mapped, 1);
      assert.equal((await db.query(`SELECT mapped_count FROM ingestion_runs
        WHERE id=$1`, [failed.runId])).rows[0].mapped_count, 3);
      assert.deepEqual(local.requests,
        ['/serie/show-1', '/temporada/s2',
          '/serie/show-1', '/temporada/s2', '/temporada/s1']);
      assert.ok(logs.some((message) => message.includes('Processed: 1 / 1')));
      const item = (await db.query(`SELECT series_id,status,attempt_count,mapping_count
        FROM ingestion_run_items WHERE run_id=$1`, [failed.runId])).rows[0];
      assert.equal(item.series_id, seriesId);
      assert.equal(item.status, 'completed');
      assert.equal(item.attempt_count, 2);
      assert.equal(item.mapping_count, 3);
      assert.deepEqual((await db.query(`SELECT provider_id,content_type,tmdb_id,
        season_number,episode_number,external_id FROM provider_media_mappings
        WHERE content_type='episode' ORDER BY season_number,episode_number`)).rows,
      [
        { provider_id: ID, content_type: 'episode', tmdb_id: 900,
          season_number: 1, episode_number: 1, external_id: '/episodio/s1e1' },
        { provider_id: ID, content_type: 'episode', tmdb_id: 900,
          season_number: 1, episode_number: 3, external_id: '/episodio/s1e3' },
        { provider_id: ID, content_type: 'episode', tmdb_id: 900,
          season_number: 2, episode_number: 3, external_id: '/episodio/s2e3' },
      ]);
      local.requests.length = 0;
      const rerun = await worker().run(options);
      assert.equal(rerun.status, 'completed');
      assert.deepEqual(rerun.mappingChanges,
        { inserted: 0, updated: 0, unchanged: 3, failed: 0 });
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS count FROM
        provider_media_mappings WHERE content_type='episode'`)).rows[0].count, 3);
      assert.equal((await db.query(`SELECT COUNT(*)::integer AS count FROM
        streams`)).rows[0].count, 0);
      assert.deepEqual(local.requests,
        ['/serie/show-1', '/temporada/s2', '/temporada/s1']);

      local.requests.length = 0;
      const batch = await worker().run({ mode: 'series_episodes', limit: 1,
        providers: [ID], workers: 1, batchSize: 1, targetMappings: 1 });
      assert.equal(batch.progress.total, 1);
      assert.deepEqual(batch.mappingChanges,
        { inserted: 0, updated: 0, unchanged: 3, failed: 0 });
      assert.deepEqual(local.requests,
        ['/serie/show-1', '/temporada/s2', '/temporada/s1']);

      const configDir = mkdtempSync(join(tmpdir(), 'kanchita-html-episode-'));
      const configPath = join(configDir, 'provider.json');
      const previousDbUrl = process.env.DB_URL;
      const scopedUrl = new URL(process.env.TEST_DB_URL);
      scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
      try {
        writeFileSync(configPath, JSON.stringify({ id: ID, region: 'global',
          baseUrl: local.baseUrl, seriesPathTemplate: '/serie/{externalId}' }));
        process.env.DB_URL = scopedUrl.toString();
        local.fail();
        const cliFailed = await worker().run(options);
        assert.equal(cliFailed.status, 'failed');
        local.recover();
        local.requests.length = 0;
        const cliResumed = await main(['--resume', cliFailed.runId,
          '--html-episode-config', configPath], { httpClient,
          now: () => Date.parse('2025-01-01T00:00:00Z') });
        assert.equal(cliResumed.runId, cliFailed.runId);
        assert.equal(cliResumed.status, 'completed');
        assert.deepEqual(cliResumed.mappingChanges,
          { inserted: 0, updated: 0, unchanged: 3, failed: 0 });
        assert.deepEqual(local.requests,
          ['/serie/show-1', '/temporada/s2', '/temporada/s1']);
        local.requests.length = 0;
        const cliRun = await main(['--html-episode-config', configPath,
          '--series-tmdb-id', '900'], { httpClient,
          now: () => Date.parse('2025-01-01T00:00:00Z') });
        assert.equal(cliRun.progress.total, 1);
        assert.deepEqual(cliRun.mappingChanges,
          { inserted: 0, updated: 0, unchanged: 3, failed: 0 });
        assert.deepEqual(local.requests,
          ['/serie/show-1', '/temporada/s2', '/temporada/s1']);
      } finally {
        if (previousDbUrl === undefined) delete process.env.DB_URL;
        else process.env.DB_URL = previousDbUrl;
        unlinkSync(configPath);
        rmdirSync(configDir);
      }

      const resolver = createProviderMediaMappingResolver({ store: mappingStore });
      const media = { contentType: 'episode', contentId: 'fixture-episode',
        tmdbId: 900, title: 'Fixture S2E3', season: 2, episode: 3 };
      assert.deepEqual(await resolver.resolve({ providerId: ID, region: 'global',
        mediaContext: { ...media, episode: 2 } }), []);
      const workflowProvider = createHttpWorkflowSourceProvider({ id: ID,
        enabled: true, baseUrl: local.baseUrl, http: httpClient,
        workflow: leafWorkflow, maxSteps: 8 });
      const mapped = createMappedSourceProviderAdapter({ provider: workflowProvider,
        providerId: ID, region: 'global', mappingResolver: resolver });
      local.requests.length = 0;
      const playback = await createSourceProviderManager({
        registry: createSourceProviderRegistry([mapped]),
        http: httpClient }).getSources(media);
      assert.deepEqual(local.requests, ['/episodio/s2e3']);
      assert.deepEqual(playback.candidates.map((candidate) => [candidate.url,
        candidate.languageHint, candidate.metadata.variant]),
      [['https://media.example.test/e3.m3u8', 'es-419', '1']]);
      assert.equal(leafWorkflow.length, 5);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
