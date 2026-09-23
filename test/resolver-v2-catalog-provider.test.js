'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { loadResolverV2Catalog } = require('../src/modules/streams/resolverV2/catalog/catalogLoader');
const { buildResolverV2CatalogRuntime } =
  require('../src/modules/streams/resolverV2/catalog/catalogRuntimeBuilder');
const { DEFAULT_CATALOG_PATH } =
  require('../src/modules/streams/resolverV2/diagnostics/catalogProviderSmoke');

test('public demo is real catalog data, valid, mapped and disabled by default', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: DEFAULT_CATALOG_PATH,
    env: {} });
  assert.equal(catalog.loaded, true);
  assert.equal(catalog.summary.errorCodes.length, 0);
  assert.equal(catalog.sources.length, 1);
  const entry = catalog.sources[0];
  assert.equal(entry.id, 'peertube_public_demo');
  assert.equal(entry.type, 'mapped_http_workflow');
  assert.equal(entry.enabled, false);
  assert.equal(entry.region, 'global');
  assert.equal(entry.supportsMovies, true);
  assert.equal(entry.supportsEpisodes, false);
  assert.deepEqual(entry.workflow.map((step) => step.type), ['request', 'extract', 'emit']);
  assert.equal(entry.workflow[0].path, '/api/v1/videos/{externalId}');
  assert.equal(entry.workflow[1].path, 'streamingPlaylists.0.playlistUrl');
  const runtime = buildResolverV2CatalogRuntime({ catalog,
    http: { request: async () => { throw new Error('Unexpected network'); } },
    mappingResolver: { resolve: async () => [] }, env: {} });
  assert.equal(runtime.sources.length, 0);
  assert.equal(runtime.summary.sourcesRegistered, 0);
});

test('catalog contains no fixed video mapping or custom PeerTube execution module', () => {
  const raw = fs.readFileSync(DEFAULT_CATALOG_PATH, 'utf8');
  assert.equal(raw.includes('7bc04dcc-1bde-4350-99a2-8d67fc1534e5'), false);
  assert.equal(raw.includes('tmdbId'), false);
  const code = fs.readFileSync(path.resolve(__dirname,
    '../src/modules/streams/resolverV2/diagnostics/catalogProviderSmoke.js'), 'utf8');
  assert.equal(code.includes('peerTubeSourceProvider'), false);
  assert.equal(code.includes('if (providerId ==='), false);
  assert.equal(code.includes('puppeteer'), false);
});
