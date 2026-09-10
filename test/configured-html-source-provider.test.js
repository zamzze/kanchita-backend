'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createConfiguredHtmlSourceProvider } =
  require('../src/modules/streams/resolverV2/providers/configuredHtmlSourceProvider');

const movie = { contentType: 'movie', contentId: 'm', tmdbId: 550, title: 'Movie' };
const episode = { contentType: 'episode', contentId: 'e', tmdbId: 10,
  title: 'Show', season: 2, episode: 3 };
const response = (html, overrides = {}) => ({ ok: true, status: 200,
  url: 'https://source.example.test/movie/550',
  headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html), ...overrides });
const make = (http, overrides = {}) => createConfiguredHtmlSourceProvider({
  id: 'html_source', baseUrl: 'https://source.example.test', enabled: true,
  allowedCandidateDomains: ['example.test'], http, ...overrides,
});

test('movie and episode templates issue one bounded HTML request', async () => {
  const calls = [];
  const http = { get: async (url, options) => { calls.push({ url, options });
    return response('<iframe src="https://embed.example.test/e/1">', { url }); } };
  const provider = make(http);
  assert.equal((await provider.getSources(movie)).length, 1);
  assert.equal((await provider.getSources(episode)).length, 1);
  assert.equal(calls[0].url, 'https://source.example.test/movie/550');
  assert.equal(calls[1].url, 'https://source.example.test/series/10/2/3');
  assert.equal(calls[0].options.headers.accept, 'text/html,application/xhtml+xml');
  assert.equal(calls.length, 2);
});

test('candidates are minimal, domain-allowlisted and never inherit source auth', async () => {
  let requestHeaders;
  const provider = make({ get: async (_url, options) => { requestHeaders = options.headers;
    return response(`<iframe src="https://embed.example.test/e/1"><video src=/local.m3u8>
      <a href="https://fakeexample.test/no"><script>'<iframe src=/evil>'</script>`); } },
  { authToken: 'source-secret', selectors: ['iframe.src', 'video.src', 'a.href'] });
  const candidates = await provider.getSources(movie);
  assert.equal(requestHeaders.authorization, 'Bearer source-secret');
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0], { providerId: 'html_source',
    url: 'https://embed.example.test/e/1',
    referer: 'https://source.example.test/movie/550', origin: 'https://source.example.test',
    headers: {}, languageHint: null, qualityHint: null,
    metadata: { discoveryType: 'iframe', sourceType: 'configured_html' } });
  assert.doesNotMatch(JSON.stringify(candidates), /source-secret|authorization|cookie/i);
});

test('redirect boundary, content type, status and transport errors are stable', async () => {
  await assert.rejects(make({ get: async () => response('', {
    url: 'https://other.example.test/x' }) }).getSources(movie),
  (error) => error.code === 'SOURCE_HTML_CROSS_ORIGIN_REDIRECT');
  await assert.rejects(make({ get: async () => response('{}', {
    headers: { 'content-type': 'application/json' } }) }).getSources(movie),
  (error) => error.code === 'SOURCE_HTML_INVALID_CONTENT_TYPE');
  await assert.rejects(make({ get: async () => ({ ...response(''), ok: false }) }).getSources(movie),
    (error) => error.code === 'SOURCE_HTML_HTTP_ERROR');
  await assert.rejects(make({ get: async () => { const error = new Error();
    error.code = 'HTTP_TIMEOUT'; throw error; } }).getSources(movie),
  (error) => error.code === 'HTTP_TIMEOUT');
});

test('invalid domains/configuration are inactive and no recursive fetch occurs', async () => {
  for (const domain of ['*', '127.0.0.1', 'localhost', 'x.localhost',
    'https://example.test', 'example.test/path']) {
    const provider = createConfiguredHtmlSourceProvider({ id: 'x', enabled: true,
      baseUrl: 'https://source.example.test', allowedCandidateDomains: [domain] });
    assert.equal(provider.descriptor.active, false);
  }
  let calls = 0;
  const provider = make({ get: async () => { calls += 1;
    return response('<iframe src="https://embed.example.test/e">'); } });
  await provider.getSources(movie);
  assert.equal(calls, 1);
});

test('source module has no browser, legacy extractor or direct transport', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'providers', 'configuredHtmlSourceProvider.js'), 'utf8');
  assert.doesNotMatch(text, /ProviderC|linkExtractor|puppeteer|playwright|browserSlots|child_process|node:vm|\beval\s*\(|new Function|\bfetch\s*\(|https?\.get\s*\(/i);
});
