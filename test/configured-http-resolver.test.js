'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const {
  createConfiguredHttpResolver,
  normalizeDomains,
} = require('../src/modules/streams/resolverV2/resolvers/configuredHttpResolver');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, body, status = 200, type = 'application/json') => {
  response.writeHead(status, type ? { 'Content-Type': type } : {});
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const candidate = (url, overrides = {}) => ({
  providerId: 'source_a', url, headers: {}, ...overrides,
});
const make = (httpClient, options = {}) => {
  const direct = createDirectHlsResolver({ httpClient, timeoutMs: 1500 });
  return createConfiguredHttpResolver({
    id: 'resolver_a', enabled: true, domains: ['127.0.0.1'],
    http: httpClient, hlsResolver: direct, timeoutMs: 1500, ...options,
  });
};

test('descriptor and domain configuration are declarative and fail closed', async () => {
  const disabled = createConfiguredHttpResolver({ enabled: false });
  assert.equal(disabled.descriptor.active, false);
  assert.deepEqual(await disabled.resolve(candidate('https://example.test/item')), []);
  for (const domains of ['', 'http://example.test', 'example.test/path', 'example.test:443']) {
    assert.equal(createConfiguredHttpResolver({ enabled: true, domains })
      .descriptor.active, false);
  }
  assert.deepEqual(normalizeDomains(' Resolver.Example.Test,example.test,resolver.example.test '),
    ['resolver.example.test', 'example.test']);
  const resolver = make({ get: async () => {}, head: async () => {} });
  assert.equal(resolver.descriptor.strategy, 'http');
  assert.equal(resolver.descriptor.requiresBrowser, false);
  assert.deepEqual(resolver.descriptor.protocols, ['hls']);
});

test('configured secrets are absent from the public descriptor', () => {
  const resolver = createConfiguredHttpResolver({
    id: 'resolver_a', enabled: true, domains: ['resolver.example.test'],
    headers: { authorization: 'Bearer resolver-secret' },
  });
  assert.doesNotMatch(JSON.stringify(resolver.descriptor), /resolver-secret|authorization/i);
});

test('private HLS output remains blocked by the V2 transport policy', async () => {
  const endpointClient = {
    get: async () => ({
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ streams: [{
        url: 'http://127.0.0.1/private.m3u8', protocol: 'hls',
      }] })),
    }),
  };
  const resolver = createConfiguredHttpResolver({
    id: 'resolver_a', enabled: true, domains: ['resolver.example.test'],
    http: endpointClient,
    hlsResolver: createDirectHlsResolver({ httpClient: createSafeHttpClient() }),
  });
  await assert.rejects(
    resolver.resolve(candidate('https://resolver.example.test/item/1')),
    (error) => error.code === 'HTTP_UNSAFE_DESTINATION'
  );
});
test('GET contract propagates safe candidate headers and maps validated HLS output', async (t) => {
  let playbackHeaders;
  const media = await listen((request, response) => {
    playbackHeaders = request.headers;
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n');
  });
  let resolverHeaders;
  const endpoint = await listen((request, response) => {
    resolverHeaders = request.headers;
    json(response, { streams: [{
      url: `${media.url}/master.m3u8`, protocol: 'hls',
      providerId: 'spoofed', resolverId: 'spoofed', quality: '1080p',
      audioLanguage: 'es-419', subtitleLanguage: 'es',
      headers: { Referer: 'https://player.example.test/', 'X-Fixture': 'yes' },
      expiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { server: 'configured', sourcePriority: 999 },
    }] }, 200, 'application/json; charset=utf-8');
  });
  t.after(() => Promise.all([close(media.server), close(endpoint.server)]));
  const resolver = make(createSafeHttpClient({ allowPrivateNetworks: true }));
  const streams = await resolver.resolve(candidate(`${endpoint.url}/item/1`, {
    referer: 'https://source.example.test/watch', origin: 'https://source.example.test',
    headers: { 'X-Candidate': 'yes' }, metadata: { sourcePriority: 17 },
  }));
  assert.equal(resolverHeaders.accept, 'application/json');
  assert.equal(resolverHeaders.referer, 'https://source.example.test/watch');
  assert.equal(resolverHeaders.origin, 'https://source.example.test');
  assert.equal(resolverHeaders['x-candidate'], 'yes');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].providerId, 'source_a');
  assert.equal(streams[0].resolverId, 'resolver_a');
  assert.equal(streams[0].protocol, 'hls');
  assert.equal(streams[0].validated, true);
  assert.equal(streams[0].quality, '1080p');
  assert.equal(streams[0].audioLanguage, 'es-419');
  assert.equal(streams[0].subtitleLanguage, 'es');
  assert.equal(streams[0].expiresAt, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(streams[0].metadata, { server: 'configured', sourcePriority: 17 });
  assert.equal(playbackHeaders.referer, 'https://player.example.test/');
  assert.equal(playbackHeaders['x-fixture'], 'yes');
});

test('empty, mixed invalid and capped stream collections are deterministic', async (t) => {
  let payload = { streams: [] };
  const media = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
  });
  const endpoint = await listen((_request, response) => json(response, payload));
  t.after(() => Promise.all([close(media.server), close(endpoint.server)]));
  const resolver = make(createSafeHttpClient({ allowPrivateNetworks: true }), { maxStreams: 2 });
  assert.deepEqual(await resolver.resolve(candidate(`${endpoint.url}/empty`)), []);
  payload = { streams: [
    { bad: true },
    { url: `${media.url}/one.m3u8`, protocol: 'hls' },
    { url: `${media.url}/two.m3u8`, protocol: 'hls' },
    { url: `${media.url}/three.m3u8`, protocol: 'hls' },
  ] };
  const streams = await resolver.resolve(candidate(`${endpoint.url}/mixed`));
  assert.equal(streams.length, 2);
});

test('JSON, Content-Type, response shape and metadata are rejected safely', async (t) => {
  const cases = {
    html: ['<html>', 'text/html', 'RESOLVER_HTTP_INVALID_CONTENT_TYPE'],
    missing_content_type: [{ streams: [] }, null, 'RESOLVER_HTTP_INVALID_CONTENT_TYPE'],
    json: ['{', 'application/json', 'RESOLVER_HTTP_INVALID_JSON'],
    root: ['[]', 'application/json', 'RESOLVER_HTTP_INVALID_RESPONSE'],
    missing: [{ value: [] }, 'application/json', 'RESOLVER_HTTP_INVALID_RESPONSE'],
    type: [{ streams: 'bad' }, 'application/json', 'RESOLVER_HTTP_INVALID_RESPONSE'],
  };
  const endpoint = await listen((request, response) => {
    const key = request.url.slice(1);
    const [body, type] = cases[key];
    json(response, body, 200, type);
  });
  t.after(() => close(endpoint.server));
  const resolver = make(createSafeHttpClient({ allowPrivateNetworks: true }));
  for (const [key, [, , code]] of Object.entries(cases)) {
    await assert.rejects(resolver.resolve(candidate(`${endpoint.url}/${key}`)),
      (error) => error.code === code);
  }
  const polluted = JSON.parse('{"streams":[{"url":"https://media.example.test/a.m3u8",' +
    '"protocol":"hls","metadata":{"__proto__":{"polluted":true}}}]}');
  const fake = make({
    get: async () => ({ ok: true, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(polluted)) }),
    head: async () => { throw new Error('must not inspect'); },
  }, { hlsResolver: { resolve: async () => { throw new Error('must not validate'); } } });
  assert.deepEqual(await fake.resolve(candidate('https://127.0.0.1/item')), []);
  assert.equal({}.polluted, undefined);
});

test('HTTP status, body limit, timeout and AbortSignal retain stable errors', async (t) => {
  const endpoint = await listen((request, response) => {
    if (request.url === '/slow') return setTimeout(() => json(response, { streams: [] }), 250);
    if (request.url === '/large') return json(response, { streams: [], pad: 'x'.repeat(2000) });
    json(response, { streams: [] }, request.url === '/404' ? 404 : 500);
  });
  t.after(() => close(endpoint.server));
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  for (const route of ['404', '500']) {
    await assert.rejects(make(client).resolve(candidate(`${endpoint.url}/${route}`)),
      (error) => error.code === 'RESOLVER_HTTP_HTTP_ERROR');
  }
  await assert.rejects(make(client, { maxBytes: 100 }).resolve(candidate(`${endpoint.url}/large`)),
    (error) => error.code === 'HTTP_RESPONSE_TOO_LARGE');
  await assert.rejects(make(client, { timeoutMs: 100 }).resolve(candidate(`${endpoint.url}/slow`)),
    (error) => error.code === 'HTTP_TIMEOUT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(make(client).resolve(candidate(`${endpoint.url}/404`),
    { signal: controller.signal }), (error) => error.code === 'HTTP_ABORTED');
});

test('redirect security strips Authorization and default SSRF remains fail-closed', async (t) => {
  const blockedClient = createSafeHttpClient();
  await assert.rejects(make(blockedClient).resolve(candidate('http://127.0.0.1:9/item')),
    (error) => error.code === 'HTTP_UNSAFE_DESTINATION');
  let authorization;
  const destination = await listen((request, response) => {
    authorization = request.headers.authorization;
    json(response, { streams: [] });
  });
  const origin = await listen((_request, response) => {
    response.writeHead(302, { Location: `${destination.url}/resolved` }); response.end();
  });
  t.after(() => Promise.all([close(origin.server), close(destination.server)]));
  const resolver = make(createSafeHttpClient({ allowPrivateNetworks: true }), {
    headers: { authorization: 'Bearer resolver-secret' },
  });
  await resolver.resolve(candidate(`${origin.url}/item`, {
    headers: { cookie: 'fixture-cookie', authorization: 'Bearer candidate-secret' },
  }));
  assert.equal(authorization, undefined);
});

test('resolver implementation is HTTP-only and contains no host-specific branches', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'resolvers', 'configuredHttpResolver.js'), 'utf8');
  assert.doesNotMatch(text,
    /puppeteer|ProviderC|browserSlots|ResolverExecutor|streamResolverChild|child_process|\bfetch\s*\(|https?\.get\s*\(/i);
  assert.doesNotMatch(text, /resolver-a|resolver-b|example\.test/i);
});
