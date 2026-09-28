'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://archive:archive@127.0.0.1:5432/archive';
process.env.JWT_SECRET ||= 'archive-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'archive-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'archive-test-tmdb';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createInternetArchiveSourceProvider, selectMp4Files, openLicense } =
  require('../src/modules/streams/resolverV2/providers/internetArchiveSourceProvider');
const { createShadowPipeline } = require('../src/modules/streams/resolverV2/createShadowPipeline');
const { normalizeCatalog } = require('../src/modules/streams/resolverV2/catalog/catalogSchema');

const ID = 'OpenFilm_1';
const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'),
  Buffer.alloc(52)]);
const media = Object.freeze({ contentType: 'movie', contentId: 'movie-fixture', tmdbId: 10378,
  title: 'Open Film' });
const ref = Object.freeze({ mappingId: 1, providerId: 'internet_archive', region: 'global',
  contentType: 'movie', tmdbId: 10378, externalId: ID, seasonNumber: null,
  episodeNumber: null, metadata: {} });

const startFixture = async (t, { license = LICENSE, files, identifier = ID } = {}) => {
  const requests = [];
  const selectedFiles = files || [
    { name: 'preview.mp4', format: 'MPEG4', source: 'derivative', size: '2000', height: '2160' },
    { name: 'movie-720.mp4', format: 'MPEG4', source: 'derivative', size: '4000', height: '720' },
    { name: 'movie-1080.mp4', format: 'MPEG4', source: 'original', size: '5000', height: '1080' },
    { name: 'thumb.jpg', format: 'JPEG', source: 'derivative', size: '2000' },
  ];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url,
      range: request.headers.range || null });
    if (request.url === `/metadata/${ID}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ metadata: { identifier, mediatype: 'movies',
        licenseurl: license }, files: selectedFiles }));
    }
    if (request.url?.startsWith(`/download/${ID}/`)) {
      response.writeHead(302, { location: '/cdn/mp4' });
      return response.end();
    }
    if (request.url === '/cdn/mp4') {
      response.setHeader('content-type', 'video/mp4');
      if (request.method === 'HEAD') return response.end();
      response.writeHead(206);
      return response.end(mp4);
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.();
    server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
};

const client = () => createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 1500 });
const provider = (baseUrl) => createInternetArchiveSourceProvider({
  enabled: true, baseUrl, http: client(), maxCandidates: 3,
});

test('license gate rejects unknown, restricted and malformed license URLs', () => {
  assert.equal(openLicense('http://creativecommons.org/licenses/by/3.0/us/'),
    'https://creativecommons.org/licenses/by/3.0/us/');
  for (const value of ['', 'https://example.test/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org/licenses/by/4.0/?token=x']) {
    assert.equal(openLicense(value), null);
  }
});

test('MP4 selection is deterministic, bounded and ignores irrelevant files', () => {
  const files = [
    { name: 'z.mp4', format: 'MP4', source: 'derivative', size: '2000', height: '720' },
    { name: 'a.mp4', format: 'MP4', source: 'original', size: '2000', height: '720' },
    { name: 'a.mp4', format: 'MP4', source: 'original', size: '2000', height: '720' },
    { name: 'trailer.mp4', format: 'MP4', source: 'original', size: '2000', height: '2160' },
    { name: 'music.mp3', format: 'MP3', source: 'original', size: '2000' },
  ];
  assert.deepEqual(selectMp4Files(files, 8).map((item) => item.name), ['a.mp4', 'z.mp4']);
  assert.deepEqual(selectMp4Files(Array(129).fill(files[0]), 8), []);
});

test('mapped source reads exact item only and emits canonical ordered MP4 candidates', async (t) => {
  const fixture = await startFixture(t);
  const result = await provider(fixture.baseUrl).getSources(media, { providerMediaRef: ref });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.qualityHint), ['1080p', '720p']);
  assert.deepEqual(result.map((item) => item.metadata.filename),
    ['movie-1080.mp4', 'movie-720.mp4']);
  assert.equal(result[0].metadata.licenseUrl, LICENSE);
  assert.equal(result[0].metadata.itemId, ID);
  assert.equal(result[0].url, `${fixture.baseUrl}/download/${ID}/movie-1080.mp4`);
  assert.deepEqual(fixture.requests.map((item) => item.url), [`/metadata/${ID}`]);
});

test('unknown rights, mismatched identity and absent mapping fail closed', async (t) => {
  const fixture = await startFixture(t, { license: 'https://example.test/unknown' });
  assert.deepEqual(await provider(fixture.baseUrl).getSources(media, { providerMediaRef: ref }), []);
  assert.deepEqual(await provider(fixture.baseUrl).getSources(media, {}), []);
  assert.equal(fixture.requests.length, 1);
  const mismatch = await startFixture(t, { identifier: 'OtherFilm' });
  assert.deepEqual(await provider(mismatch.baseUrl).getSources(media,
    { providerMediaRef: ref }), []);
});

test('catalog source resolves local MP4 through manager, engine and Primary without CDN identity',
  async (t) => {
    const fixture = await startFixture(t);
    const mappingCalls = [];
    const mappingResolver = { resolve: async (input) => {
      mappingCalls.push(input);
      return [ref];
    } };
    const catalog = { version: 1, sources: [{ id: 'internet_archive',
      type: 'internet_archive', enabled: true, region: 'global',
      baseUrl: fixture.baseUrl, supportsEpisodes: false, maxCandidates: 1 }], resolvers: [] };
    const pipeline = createShadowPipeline({ catalogEnabled: true, catalogPath: 'fixture.json',
      catalogReadFile: () => JSON.stringify(catalog), providerMappingResolver: mappingResolver,
      httpClient: client(), enabled: false, primaryEnabled: true,
      primaryTimeoutMs: 5000, healthEnabled: false });
    assert.equal(pipeline.catalogSummary.sourcesRegistered, 1);
    const result = await pipeline.primaryResolver.resolve(media);
    assert.equal(result.status, 'accepted');
    assert.equal(result.selected.protocol, 'mp4');
    assert.equal(result.selected.validated, true);
    assert.equal(result.selected.url,
      `${fixture.baseUrl}/download/${ID}/movie-1080.mp4`);
    assert.equal(result.selected.metadata.licenseUrl, LICENSE);
    assert.equal(mappingCalls.length, 1);
    assert.deepEqual(fixture.requests.map((item) => item.method),
      ['GET', 'HEAD', 'HEAD', 'GET']);
    assert.deepEqual(fixture.requests.filter((item) => item.method === 'GET' &&
      item.url === '/cdn/mp4').map((item) => item.range), ['bytes=0-63']);
    assert.equal(fixture.requests.some((item) => item.url.includes('catalog') ||
      item.url.includes('search')), false);
  });

test('default client denies private fixture destination', async (t) => {
  const fixture = await startFixture(t);
  const source = createInternetArchiveSourceProvider({ enabled: true,
    baseUrl: fixture.baseUrl, http: createSafeHttpClient() });
  await assert.rejects(source.getSources(media, { providerMediaRef: ref }),
    (error) => error.code === 'HTTP_UNSAFE_DESTINATION');
  assert.equal(fixture.requests.length, 0);
});

test('catalog sample stays disabled and contains no item IDs', () => {
  const file = path.join(__dirname, '..', 'config', 'resolver-v2',
    'internet-archive-open.catalog.json');
  const contents = fs.readFileSync(file, 'utf8');
  const normalized = normalizeCatalog(JSON.parse(contents));
  assert.equal(normalized.sources[0].enabled, false);
  assert.equal(normalized.sources[0].type, 'internet_archive');
  assert.equal(contents.includes(ID), false);
});
