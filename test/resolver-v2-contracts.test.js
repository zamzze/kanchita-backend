'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeMediaContext,
  normalizeEmbedCandidate,
  normalizeStreamCandidate,
  normalizeResolverDescriptor,
  isValidMediaContext,
  isValidEmbedCandidate,
  isValidStreamCandidate,
  isValidResolverDescriptor,
} = require('../src/modules/streams/resolverV2/resolverContracts');

const root = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'streams');

test('MediaContext preserves content identity and validates movie/episode metadata', () => {
  const opaqueId = ' external:key:0001 ';
  assert.deepEqual(normalizeMediaContext({
    contentType: 'movie', contentId: opaqueId, tmdbId: 550, title: 'Fight Club',
  }), {
    contentType: 'movie', contentId: opaqueId, tmdbId: 550, title: 'Fight Club',
    season: null, episode: null,
  });
  assert.deepEqual(normalizeMediaContext({
    contentType: 'episode', contentId: 'episode-1', tmdbId: 1399,
    title: 'Winter Is Coming', season: 1, episode: 1,
  }), {
    contentType: 'episode', contentId: 'episode-1', tmdbId: 1399,
    title: 'Winter Is Coming', season: 1, episode: 1,
  });
  assert.equal(isValidMediaContext({ contentType: 'movie', contentId: '', tmdbId: 1, title: 'x' }), false);
  assert.equal(isValidMediaContext({ contentType: 'episode', contentId: 'x', tmdbId: 1, title: 'x' }), false);
  assert.equal(normalizeMediaContext(null), null);
});

test('EmbedCandidate normalizes safe headers and JSON-like metadata', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturePath, 'candidate-direct.json'), 'utf8'));
  const candidate = normalizeEmbedCandidate(fixture);
  assert.equal(candidate.providerId, 'fixture_provider');
  assert.equal(candidate.headers['accept-language'], 'es-419,es;q=0.9');
  assert.deepEqual(candidate.metadata, { fixture: true, source: 'synthetic' });
  assert.equal(isValidEmbedCandidate(fixture), true);
  assert.equal(normalizeEmbedCandidate({ ...fixture, url: 'javascript:alert(1)' }), null);
  assert.equal(normalizeEmbedCandidate({ ...fixture, referer: 'file:///tmp/a' }), null);
  assert.equal(normalizeEmbedCandidate({ ...fixture, headers: { X: 42 } }), null);
  assert.equal(normalizeEmbedCandidate({ ...fixture, metadata: { execute() {} } }), null);
  assert.equal(normalizeEmbedCandidate({ ...fixture, metadata: new Date() }), null);
});

test('EmbedCandidate rejects cyclic or executable metadata without throwing', () => {
  const metadata = {};
  metadata.self = metadata;
  const input = { providerId: 'fixture', url: 'https://embed.example.test', metadata };
  assert.doesNotThrow(() => normalizeEmbedCandidate(input));
  assert.equal(normalizeEmbedCandidate(input), null);
});

test('StreamCandidate enforces protocols, dates, latency and normalized headers', () => {
  const input = {
    url: 'https://media.example.test/master.m3u8', protocol: 'hls',
    providerId: 'fixture_provider', resolverId: 'direct_fixture',
    headers: { Referer: 'https://catalog.example.test/' },
    expiresAt: '2030-01-01T00:00:00Z', latencyMs: 12.5, validated: true,
    quality: '1080p', audioLanguage: 'es-419', subtitleLanguage: 'es',
    hlsInfo: { isMaster: true, variants: [{ height: 1080 }] },
  };
  const candidate = normalizeStreamCandidate(input);
  assert.equal(candidate.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(candidate.headers, { referer: 'https://catalog.example.test/' });
  assert.equal(candidate.validated, true);
  assert.equal(isValidStreamCandidate(input), true);
  assert.equal(normalizeStreamCandidate({ ...input, protocol: 'torrent' }), null);
  assert.equal(normalizeStreamCandidate({ ...input, latencyMs: -1 }), null);
  assert.equal(normalizeStreamCandidate({ ...input, expiresAt: 'never' }), null);
  assert.equal(normalizeStreamCandidate({ ...input, validated: 'yes' }), null);
});

test('ResolverDescriptor is declarative, bounded and lowercases identifiers', () => {
  const descriptor = normalizeResolverDescriptor({
    id: 'Fixture_Direct', active: false, priority: 100,
    protocols: ['HLS', 'mp4', 'HLS'],
    domains: ['MEDIA.EXAMPLE.TEST', '*.CDN.EXAMPLE.TEST'],
    aliases: ['FIXTURE', 'fixture'],
    urlPatterns: ['/embed/{id}', '/movie/{tmdbId}'], requiresBrowser: false,
  });
  assert.deepEqual(descriptor, {
    id: 'fixture_direct', active: false, priority: 100,
    protocols: ['hls', 'mp4'], domains: ['media.example.test', '*.cdn.example.test'],
    aliases: ['fixture'], urlPatterns: ['/embed/{id}', '/movie/{tmdbId}'],
    requiresBrowser: false,
  });
  assert.equal(isValidResolverDescriptor({ ...descriptor }), true);
  assert.equal(normalizeResolverDescriptor({ ...descriptor, urlPatterns: [/unsafe/] }), null);
  assert.equal(normalizeResolverDescriptor({ ...descriptor, active: 1 }), null);
  assert.equal(normalizeResolverDescriptor({ ...descriptor, protocols: ['hls', 'ftp'] }), null);
});

test('all public normalizers fail closed for ordinary malformed inputs', () => {
  for (const normalize of [normalizeMediaContext, normalizeEmbedCandidate,
    normalizeStreamCandidate, normalizeResolverDescriptor]) {
    for (const input of [undefined, null, true, 1, 'x', [], () => {}]) {
      assert.doesNotThrow(() => normalize(input));
      assert.equal(normalize(input), null);
    }
  }
});

test('Resolver V2 Phase A remains isolated from network, browser and ProviderC', () => {
  const moduleDirectory = path.join(root, 'src', 'modules', 'streams', 'resolverV2');
  const newFiles = fs.readdirSync(moduleDirectory)
    .filter((name) => name.endsWith('.js')).map((name) => path.join(moduleDirectory, name));
  assert.deepEqual(newFiles.map((file) => path.basename(file)).sort(), [
    'hlsInspector.js', 'resolverContracts.js', 'resolverRegistry.js',
  ]);

  for (const file of newFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /ProviderC|providerC|puppeteer-real-browser/);
    assert.doesNotMatch(source, /require\(['"](?:node:)?(?:http|https|net|dns|tls)['"]\)/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }
});
