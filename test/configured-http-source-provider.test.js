'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  createConfiguredHttpSourceProvider,
} = require('../src/modules/streams/resolverV2/providers/configuredHttpSourceProvider');

const movie = { contentType: 'movie', contentId: 'm1', tmdbId: 10, title: 'Movie' };
const episode = {
  contentType: 'episode', contentId: 'e1', tmdbId: 20, title: 'Series', season: 2, episode: 3,
};
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, body, status = 200, contentType = 'application/json') => {
  response.writeHead(status, contentType ? { 'Content-Type': contentType } : {});
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const source = (overrides = {}) => ({
  url: 'https://media.example.test/master.m3u8',
  referer: 'https://media.example.test/watch', origin: 'https://media.example.test',
  headers: { 'User-Agent': 'Fixture/1.0' }, language: 'es-419', quality: '1080p',
  metadata: { server: 'direct' }, ...overrides,
});
const make = (baseUrl, options = {}) => createConfiguredHttpSourceProvider({
  id: 'provider_a', baseUrl, enabled: true, timeoutMs: 1500, maxCandidates: 8,
  http: createSafeHttpClient({ allowPrivateNetworks: true }), ...options,
});

test('descriptor is HTTP-only and disabled or invalid URLs remain inactive', async () => {
  const disabled = createConfiguredHttpSourceProvider({ enabled: false });
  assert.equal(disabled.descriptor.active, false);
  assert.deepEqual(await disabled.getSources(movie), []);
  for (const baseUrl of ['', 'not-a-url', 'file:///tmp/a', 'ftp://example.test/a',
    'https://user:pass@example.test']) {
    const provider = createConfiguredHttpSourceProvider({ enabled: true, baseUrl });
    assert.equal(provider.descriptor.active, false);
  }
  const provider = make('https://api.example.test/root');
  assert.deepEqual(provider.descriptor, {
    id: 'provider_a', active: true, priority: 100, supportsMovies: true,
    supportsEpisodes: true, languages: [], strategy: 'http', timeoutMs: 1500,
    maxCandidates: 8,
  });
});

test('movie and episode requests expose only public lookup metadata', async (t) => {
  const requests = [];
  const requestHeaders = [];
  const fixture = await listen((request, response) => {
    requests.push(request.url);
    requestHeaders.push(request.headers);
    json(response, { sources: [] }, 200, 'application/json; charset=utf-8');
  });
  t.after(() => close(fixture.server));
  const provider = make(`${fixture.url}/api`);
  await provider.getSources(movie);
  await provider.getSources(episode);
  assert.deepEqual(requests, [
    '/api/sources/movie/10', '/api/sources/episode/20?season=2&episode=3',
  ]);
  assert.doesNotMatch(requests.join(''), /contentId|title|user|jwt/i);
  assert.equal(requestHeaders[0].accept, 'application/json');
  assert.equal(requestHeaders[0].authorization, undefined);
  assert.equal(requestHeaders[0].cookie, undefined);
});

test('valid JSON maps only normalized EmbedCandidates and forces providerId', async (t) => {
  const fixture = await listen((_request, response) => json(response, {
    sources: [source({ providerId: 'spoofed' }), { bad: true },
      source({ url: 'https://media.example.test/two.m3u8', quality: '720p' })],
  }));
  t.after(() => close(fixture.server));
  const candidates = await make(fixture.url).getSources(movie);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].providerId, 'provider_a');
  assert.equal(candidates[0].referer, 'https://media.example.test/watch');
  assert.equal(candidates[0].origin, 'https://media.example.test');
  assert.equal(candidates[0].headers['user-agent'], 'Fixture/1.0');
  assert.equal(candidates[0].languageHint, 'es-419');
  assert.equal(candidates[0].qualityHint, '1080p');
  assert.deepEqual(candidates[0].metadata, { server: 'direct' });
});

test('response structure, JSON and Content-Type are validated', async (t) => {
  const cases = new Map([
    ['/html', ['<html>', 'text/html', 'SOURCE_HTTP_INVALID_CONTENT_TYPE']],
    ['/invalid-json', ['{', 'application/json', 'SOURCE_HTTP_INVALID_JSON']],
    ['/root-array', ['[]', 'application/json', 'SOURCE_HTTP_INVALID_RESPONSE']],
    ['/missing', [{ value: [] }, 'application/json', 'SOURCE_HTTP_INVALID_RESPONSE']],
    ['/string', [{ sources: 'bad' }, 'application/json', 'SOURCE_HTTP_INVALID_RESPONSE']],
    ['/invalid-source', [{ sources: [{ bad: true }] }, 'application/json',
      'SOURCE_HTTP_INVALID_RESPONSE']],
  ]);
  const fixture = await listen((request, response) => {
    const route = [...cases.keys()].find((key) => request.url.startsWith(`${key}/`));
    const [body, type] = cases.get(route);
    json(response, body, 200, type);
  });
  t.after(() => close(fixture.server));
  for (const [route, [, , code]] of cases) {
    await assert.rejects(make(`${fixture.url}${route}`).getSources(movie),
      (error) => error.code === code);
  }
});

test('missing Content-Type is accepted, while HTTP errors are stable', async (t) => {
  const fixture = await listen((request, response) => {
    if (request.url.includes('/ok/')) return json(response, { sources: [] }, 200, null);
    return json(response, { sources: [] }, request.url.includes('/404/') ? 404 : 500);
  });
  t.after(() => close(fixture.server));
  assert.deepEqual(await make(`${fixture.url}/ok`).getSources(movie), []);
  for (const route of ['404', '500']) {
    await assert.rejects(make(`${fixture.url}/${route}`).getSources(movie),
      (error) => error.code === 'SOURCE_HTTP_HTTP_ERROR');
  }
});

test('candidate count, body size, timeout, abort and redirects are bounded', async (t) => {
  let calls = 0;
  const fixture = await listen((request, response) => {
    calls += 1;
    if (request.url.startsWith('/redirect/')) {
      response.writeHead(302, { Location: '/ok/sources/movie/10' }); return response.end();
    }
    if (request.url.startsWith('/slow/')) return setTimeout(() => json(response, { sources: [] }), 100);
    if (request.url.startsWith('/large/')) return json(response, { sources: [source({
      metadata: { padding: 'x'.repeat(2000) },
    })] });
    json(response, { sources: Array.from({ length: 5 }, (_, i) => source({
      url: `https://media.example.test/${i}.m3u8`,
    })) });
  });
  t.after(() => close(fixture.server));
  assert.equal((await make(`${fixture.url}/ok`, { maxCandidates: 2 }).getSources(movie)).length, 2);
  assert.equal((await make(`${fixture.url}/redirect`).getSources(movie)).length, 5);
  await assert.rejects(make(`${fixture.url}/large`, { maxBytes: 100 }).getSources(movie),
    (error) => error.code === 'HTTP_RESPONSE_TOO_LARGE');
  await assert.rejects(make(`${fixture.url}/slow`, { timeoutMs: 100 }).getSources(movie),
    (error) => error.code === 'HTTP_TIMEOUT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(make(`${fixture.url}/ok`).getSources(movie, { signal: controller.signal }),
    (error) => error.code === 'HTTP_ABORTED');
  assert.ok(calls >= 5);
});

test('SSRF and cross-origin authorization remain governed by SafeHttpClient', async (t) => {
  const blocked = createConfiguredHttpSourceProvider({
    id: 'provider_a', enabled: true, baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500,
    maxCandidates: 8, http: createSafeHttpClient(),
  });
  await assert.rejects(blocked.getSources(movie),
    (error) => error.code === 'HTTP_UNSAFE_DESTINATION');

  let receivedAuthorization = null;
  const destination = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization || null;
    json(response, { sources: [] });
  });
  const origin = await listen((_request, response) => {
    response.writeHead(302, { Location: `${destination.url}/sources/movie/10` }); response.end();
  });
  t.after(() => Promise.all([close(origin.server), close(destination.server)]));
  const provider = make(origin.url, { headers: { authorization: 'Bearer test-secret' } });
  await provider.getSources(movie);
  assert.equal(receivedAuthorization, null);

  let sameOriginAuthorization = null;
  const sameOrigin = await listen((request, response) => {
    sameOriginAuthorization = request.headers.authorization || null;
    json(response, { sources: [] });
  });
  t.after(() => close(sameOrigin.server));
  await make(sameOrigin.url, { headers: { authorization: 'Bearer test-secret' } })
    .getSources(movie);
  assert.equal(sameOriginAuthorization, 'Bearer test-secret');
});

test('provider source contains no browser or direct transport implementation', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'providers', 'configuredHttpSourceProvider.js'), 'utf8');
  assert.doesNotMatch(text,
    /puppeteer|ProviderC|providerC|browserSlots|ResolverExecutor|child_process|\bfetch\s*\(|https?\.get\s*\(/i);
});
