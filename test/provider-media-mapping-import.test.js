'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyImport, normalizeRecord, prepareImport } =
  require('../src/modules/streams/providerMediaMappingImport');
const { parseArgs, run } = require('../scripts/import-provider-mappings');

const idA = '0123456789abcdef01234567';
const idB = 'abcdef0123456789abcdef01';

test('importer accepts both formats and validates Pluto ObjectIds', () => {
  assert.equal(normalizeRecord({ movie: 'Movie', year: 2010, pluto_id: idA,
    tmdb_id: 123, match: 'manual' }, { providerId: 'pluto', region: 'latam' }).matchMethod,
  'manual');
  assert.equal(normalizeRecord(['Movie', 2010, idA, 123],
    { providerId: 'pluto', region: 'latam' }).externalId, idA);
  assert.equal(normalizeRecord(['Movie', 2010, 'not-object-id', 123],
    { providerId: 'pluto', region: 'latam' }), null);
});

test('import preparation deduplicates exact rows and isolates conflicting external IDs', () => {
  const prepared = prepareImport([
    ['One', 2010, idA, 1],
    ['One', 2010, idA, 1],
    ['Conflict', 2011, idB, 2],
    ['Conflict other TMDB', 2011, idB, 3],
    ['Invalid', 2010, 'bad', 4],
  ], { providerId: 'pluto', region: 'latam' });
  assert.equal(prepared.input, 5);
  assert.equal(prepared.mappings.length, 1);
  assert.equal(prepared.invalid, 1);
  assert.equal(prepared.conflicts, 1);
});

test('dry-run is default and apply reports store outcomes without deletes', async () => {
  assert.equal(parseArgs(['--provider', 'pluto', '--region', 'latam', '--file', 'x.json']).apply,
    false);
  assert.equal(parseArgs(['--provider', 'pluto', '--region', 'latam', '--file', 'x.json',
    '--apply']).apply, true);
  assert.equal(parseArgs(['--provider', 'other', '--region', 'latam', '--file', 'x.json']), null);
  assert.equal(parseArgs(['--provider', 'pluto', '--region', 'latam', '--file', 'x.json',
    '--dry-run', '--apply']), null);
  const prepared = prepareImport([['One', 2010, idA, 1], ['Two', 2011, idB, 2]],
    { providerId: 'pluto', region: 'latam' });
  let writes = 0;
  const dry = await applyImport({ prepared, store: { upsertMapping: async () => {
    writes += 1;
  } }, dryRun: true });
  assert.equal(writes, 0);
  assert.deepEqual(dry, { input: 2, valid: 2, invalid: 0, inserted: 0, updated: 0,
    unchanged: 0, conflicts: 0 });
  const outcomes = ['inserted', 'conflict'];
  const applied = await applyImport({ prepared, store: { upsertMapping: async () => ({
    change: outcomes.shift(),
  }) }, dryRun: false });
  assert.equal(applied.inserted, 1);
  assert.equal(applied.conflicts, 1);
});

test('apply mode wraps every upsert in one transaction', async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
    return { rows: sql.includes('INSERT INTO provider_media_mappings')
      ? [{ id: 1, inserted: true }] : [] };
  }, release() { statements.push('RELEASE'); } };
  const pool = { connect: async () => client, end: async () => statements.push('END') };
  const previous = process.env.DB_URL;
  process.env.DB_URL = 'postgresql://unused.invalid/test';
  try {
    const summary = await run({ providerId: 'pluto', region: 'latam', file: 'fixture.json',
      apply: true }, {
      readFile: async () => JSON.stringify([['Movie', 2010, idA, 1]]),
      poolFactory: () => pool,
    });
    assert.equal(summary.inserted, 1);
    assert.equal(statements[0], 'BEGIN');
    assert.ok(statements.includes('COMMIT'));
    assert.ok(!statements.includes('ROLLBACK'));
    assert.deepEqual(statements.slice(-2), ['RELEASE', 'END']);
  } finally {
    if (previous === undefined) delete process.env.DB_URL;
    else process.env.DB_URL = previous;
  }
});
