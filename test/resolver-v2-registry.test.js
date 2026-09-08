'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');

const candidate = { providerId: 'fixture', url: 'https://media.example.test/play' };
const fakeResolver = (id, priority = 1, { active = true, matches = true } = {}) => ({
  descriptor: {
    id, active, priority, protocols: ['hls'], domains: [], aliases: [],
    urlPatterns: [], requiresBrowser: false,
  },
  canResolve: () => matches,
  resolve: async () => [],
});

test('empty registry and exact lookup have stable results', () => {
  const registry = createResolverRegistry();
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.detect(candidate), []);
  assert.equal(registry.get('missing'), null);
});

test('register validates resolver contract and rejects duplicate IDs', () => {
  const registry = createResolverRegistry();
  const registered = registry.register(fakeResolver('fixture'));
  assert.equal(registry.get('fixture'), registered);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register(fakeResolver('fixture')),
    (error) => error.code === 'DUPLICATE_RESOLVER_ID');
  assert.throws(() => registry.register({ ...fakeResolver('bad'), canResolve: null }),
    (error) => error.code === 'INVALID_RESOLVER');
  assert.throws(() => registry.register({ ...fakeResolver('bad'), resolve: null }),
    (error) => error.code === 'INVALID_RESOLVER');
  assert.throws(() => registry.register({
    ...fakeResolver('bad'), descriptor: { ...fakeResolver('bad').descriptor, protocols: ['ftp'] },
  }), (error) => error.code === 'INVALID_RESOLVER');
});

test('detect normalizes input, filters inactive/nonmatching and never resolves', () => {
  let resolveCalls = 0;
  let canResolveCandidate;
  const active = fakeResolver('active', 10);
  active.canResolve = (value) => { canResolveCandidate = value; return true; };
  active.resolve = async () => { resolveCalls += 1; return []; };
  const registry = createResolverRegistry([
    active,
    fakeResolver('inactive', 100, { active: false }),
    fakeResolver('no_match', 50, { matches: false }),
  ]);

  assert.deepEqual(registry.detect(candidate).map(({ descriptor }) => descriptor.id), ['active']);
  assert.equal(canResolveCandidate.providerId, 'fixture');
  assert.equal(resolveCalls, 0);
  assert.deepEqual(registry.detect({ providerId: 'fixture', url: 'ftp://invalid' }), []);
});

test('list and detect use deterministic priority and ID ordering', () => {
  const registry = createResolverRegistry([
    fakeResolver('zeta', 50), fakeResolver('alpha', 50), fakeResolver('highest', 100),
  ]);
  const expected = ['highest', 'alpha', 'zeta'];
  assert.deepEqual(registry.list().map(({ descriptor }) => descriptor.id), expected);
  assert.deepEqual(registry.detect(candidate).map(({ descriptor }) => descriptor.id), expected);
});

test('returned collections and descriptors cannot mutate registry state', () => {
  const registry = createResolverRegistry([fakeResolver('fixture', 5)]);
  const listed = registry.list();
  listed.length = 0;
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.get('fixture').descriptor.protocols.push('mp4'), TypeError);
  assert.deepEqual(registry.get('fixture').descriptor.protocols, ['hls']);
});

test('canResolve exceptions remain visible and detect performs no network work', () => {
  const registry = createResolverRegistry([{
    ...fakeResolver('broken'),
    canResolve: () => { throw new Error('resolver bug'); },
  }]);
  assert.throws(() => registry.detect(candidate), /resolver bug/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'resolverRegistry.js'), 'utf8');
  assert.doesNotMatch(source, /node:http|node:https|\bfetch\s*\(|puppeteer|ProviderC|providerC/);
  assert.doesNotMatch(source, /readdir|dynamic import|require\([^'"\s]/);
});
