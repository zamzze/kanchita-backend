'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');

const valid = JSON.stringify({ version: 1, sources: [{ id: 'source_a',
  type: 'configured_http', enabled: true, baseUrl: 'https://source.example.test',
  authTokenEnv: 'STREAM_RESOLVER_V2_SECRET_SOURCE_A' }], resolvers: [] });

test('disabled and missing/local-only paths fail closed without unnecessary reads', () => {
  let reads = 0;
  const readFile = () => { reads += 1; return valid; };
  assert.equal(loadResolverV2Catalog({ readFile }).summary.errorCodes[0], 'CATALOG_DISABLED');
  assert.equal(loadResolverV2Catalog({ enabled: true, readFile }).summary.errorCodes[0],
    'CATALOG_PATH_MISSING');
  assert.equal(loadResolverV2Catalog({ enabled: true, filePath: 'https://catalog.example.test',
    readFile }).summary.errorCodes[0], 'CATALOG_PATH_MISSING');
  assert.equal(reads, 0);
});

test('read errors, invalid JSON, empty content and oversized files use stable codes', () => {
  assert.equal(loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => { throw new Error('sensitive path'); } }).summary.errorCodes[0],
  'CATALOG_READ_FAILED');
  for (const input of ['', '{']) {
    assert.equal(loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
      readFile: () => input }).summary.errorCodes[0], 'CATALOG_INVALID_JSON');
  }
  assert.equal(loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    maxBytes: 10, readFile: () => valid }).summary.errorCodes[0], 'CATALOG_TOO_LARGE');
});

test('BOM, CRLF and whitespace load through an injected reader', () => {
  let receivedPath;
  const result = loadResolverV2Catalog({ enabled: true, filePath: ' catalog.json ',
    env: { STREAM_RESOLVER_V2_SECRET_SOURCE_A: 'secret-value' },
    readFile: (filePath) => { receivedPath = filePath;
      return Buffer.from(`\uFEFF  ${valid.replace(/,/g, ',\r\n')}  `); } });
  assert.equal(receivedPath, 'catalog.json');
  assert.equal(result.loaded, true);
  assert.equal(result.sources.length, 1);
});

test('partial invalid entries remain observable without exposing catalog data', () => {
  const payload = JSON.stringify({ version: 1, sources: [
    { id: 'good', type: 'configured_http', enabled: true,
      baseUrl: 'https://source.example.test' },
    { id: 'bad id', type: 'configured_http', enabled: true,
      baseUrl: 'https://bad.example.test' },
  ] });
  const result = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => payload, env: {} });
  assert.equal(result.loaded, true);
  assert.equal(result.sources.length, 1);
  assert.equal(result.summary.skippedSources, 1);
  assert.deepEqual(result.summary.errorCodes, ['CATALOG_INVALID_SOURCE']);
  assert.doesNotMatch(JSON.stringify(result.summary), /source\.example|catalog\.json|https?:/);
});

test('declared missing secrets skip only their entries and never expose values', () => {
  const missing = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => valid, env: {} });
  assert.equal(missing.sources.length, 0);
  assert.deepEqual(missing.summary.errorCodes, ['CATALOG_MISSING_SECRET']);
  const present = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => valid,
    env: { STREAM_RESOLVER_V2_SECRET_SOURCE_A: 'super-secret-test' } });
  assert.equal(present.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(present), /super-secret-test/);
});

test('unsupported versions and structural limits are safe global failures', () => {
  const unsupported = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => '{"version":2}' });
  assert.equal(unsupported.loaded, false);
  assert.deepEqual(unsupported.summary.errorCodes, ['CATALOG_UNSUPPORTED_VERSION']);
  const limited = loadResolverV2Catalog({ enabled: true, filePath: 'catalog.json',
    readFile: () => JSON.stringify({ version: 1, sources: [
      { id: 'a', type: 'configured_http' }, { id: 'b', type: 'configured_http' },
    ] }), limits: { sources: 1 } });
  assert.deepEqual(limited.summary.errorCodes, ['CATALOG_LIMIT_EXCEEDED']);
});

test('loader implementation executes no dynamic code, network or discovery', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'catalog', 'catalogLoader.js'), 'utf8');
  assert.doesNotMatch(source, /require\s*\(\s*(?!['"]node:fs['"])[^'"]/);
  assert.doesNotMatch(source, /\beval\s*\(|new Function|node:vm|fs\.watch|readdir|fetch\s*\(/);
});
