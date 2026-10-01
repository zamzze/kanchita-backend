'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createConfiguredHtmlResolver } =
  require('../src/modules/streams/resolverV2/resolvers/configuredHtmlResolver');
const { createPrimaryAcceptanceGate } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');

const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n';
const listen = async (handler) => { const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server; };
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const dnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
const candidate = (url, overrides = {}) => ({ providerId: 'html_source', url,
  referer: 'http://source.example.test/movie/550', origin: 'http://source.example.test',
  headers: {}, ...overrides });
const make = (client, overrides = {}) => {
  const directHlsResolver = createDirectHlsResolver({ httpClient: client, timeoutMs: 500 });
  return createConfiguredHtmlResolver({ id: 'html_resolver', enabled: true,
    domains: ['embed.example.test'], pathPrefixes: ['/e/'],
    allowedMediaDomains: ['media.example.test'], http: client, directHlsResolver,
    timeoutMs: 500, ...overrides });
};

test('descriptor, policies and static HTML result identity are strict', async () => {
  const directCalls = [];
  const httpClient = { get: async (_url, options) => ({ ok: true,
    url: 'https://embed.example.test/e/a', headers: { 'content-type': 'text/html' },
    body: Buffer.from('<video src="https://media.example.test/play/a">'), options }) };
  const resolver = createConfiguredHtmlResolver({ id: 'html_resolver', enabled: true,
    domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'],
    requestHeaderPolicy: 'referer_origin', playbackHeaderPolicy: 'referer', http: httpClient,
    directHlsResolver: { resolve: async (input) => { directCalls.push(input); return [{
      url: input.url, protocol: 'hls', providerId: input.providerId, resolverId: 'direct_hls',
      headers: input.headers, validated: true, latencyMs: 1, metadata: null,
    }]; } } });
  const streams = await resolver.resolve(candidate('https://embed.example.test/e/a'));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].providerId, 'html_source');
  assert.equal(streams[0].resolverId, 'html_resolver');
  assert.deepEqual(streams[0].headers, { referer: 'https://embed.example.test/e/a' });
  assert.equal(streams[0].metadata.resolverStrategy, 'http');
  assert.deepEqual(directCalls[0].headers, { referer: 'https://embed.example.test/e/a' });
  const disabled = createConfiguredHtmlResolver({ enabled: false });
  assert.deepEqual(await disabled.resolve(candidate('https://embed.example.test/e/a')), []);
  assert.equal(resolver.canResolve(candidate('https://embed.example.test/direct.m3u8')), false);
});

test('real HLS validation sends derived Referer and Origin and remains primary-rejected', async (t) => {
  const received = [];
  const server = await listen((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    const port = server.address().port;
    if (request.url === '/e/referer') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<video src="http://media.example.test:${port}/referer.m3u8">`);
    }
    if (request.url === '/e/origin') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<source src="http://media.example.test:${port}/origin">`);
    }
    const expectedReferer = `http://embed.example.test:${port}${request.url === '/origin' ? '/e/origin' : '/e/referer'}`;
    const valid = request.headers.referer === expectedReferer &&
      (request.url !== '/origin' || request.headers.origin === `http://embed.example.test:${port}`);
    response.writeHead(valid ? 200 : 403, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(valid ? manifest : 'denied');
  });
  t.after(() => close(server));
  const port = server.address().port;
  const client = createSafeHttpClient({ allowPrivateNetworks: true, dnsLookup, timeoutMs: 600 });
  const refererResolver = make(client, { playbackHeaderPolicy: 'referer' });
  const refererStreams = await refererResolver.resolve(candidate(
    `http://embed.example.test:${port}/e/referer`));
  assert.equal(refererStreams.length, 1);
  assert.equal(refererStreams[0].validated, true);
  assert.equal(createPrimaryAcceptanceGate().evaluate(refererStreams[0]).code,
    'PRIMARY_HEADERS_UNSUPPORTED');

  const originResolver = make(client, { playbackHeaderPolicy: 'referer_origin' });
  const originStreams = await originResolver.resolve(candidate(
    `http://embed.example.test:${port}/e/origin`));
  assert.equal(originStreams.length, 1);
  assert.deepEqual(originStreams[0].headers, {
    referer: `http://embed.example.test:${port}/e/origin`,
    origin: `http://embed.example.test:${port}`,
  });
  assert.equal(received.some((entry) => entry.headers.cookie), false);
  assert.equal(received.some((entry) => entry.headers.authorization), false);
});

test('headerless media validates and is primary-compatible', async (t) => {
  const server = await listen((request, response) => {
    const port = server.address().port;
    if (request.url === '/e/open') { response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<video src="http://media.example.test:${port}/open.m3u8">`); }
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(manifest);
  });
  t.after(() => close(server));
  const port = server.address().port;
  const client = createSafeHttpClient({ allowPrivateNetworks: true, dnsLookup });
  const streams = await make(client, { playbackHeaderPolicy: 'none' }).resolve(candidate(
    `http://embed.example.test:${port}/e/open`));
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0].headers, {});
  assert.equal(createPrimaryAcceptanceGate().evaluate(streams[0]).code, 'PRIMARY_ACCEPTED');
});

test('HTML contract, redirect domain and invalid media fail closed', async () => {
  const direct = { resolve: async () => [] };
  const options = { id: 'x', enabled: true, domains: ['embed.example.test'],
    allowedMediaDomains: ['media.example.test'], directHlsResolver: direct };
  const makeFake = (result) => createConfiguredHtmlResolver({ ...options,
    http: { get: async () => result } });
  await assert.rejects(makeFake({ ok: true, url: 'https://embed.example.test/e',
    headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })
    .resolve(candidate('https://embed.example.test/e')),
  (error) => error.code === 'RESOLVER_HTML_INVALID_CONTENT_TYPE');
  await assert.rejects(makeFake({ ok: true, url: 'https://other.example.test/e',
    headers: { 'content-type': 'text/html' }, body: Buffer.from('') })
    .resolve(candidate('https://embed.example.test/e')),
  (error) => error.code === 'RESOLVER_HTML_CROSS_DOMAIN_REDIRECT');
  const resolver = makeFake({ ok: true, url: 'https://embed.example.test/e',
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<video src="https://evil.example.org/x"><script>x.m3u8</script><iframe src="https://media.example.test/nested">') });
  assert.deepEqual(await resolver.resolve(candidate('https://embed.example.test/e')), []);
});

test('resolveNode emits bounded nested candidates without fetching them', async () => {
  let pageCalls = 0;
  let hlsCalls = 0;
  const resolver = createConfiguredHtmlResolver({ id: 'html_resolver', enabled: true,
    domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'],
    allowedNestedDomains: ['next.example.test'], maxNextCandidates: 2,
    http: { get: async () => { pageCalls += 1; return { ok: true,
      url: 'https://embed.example.test/e/a', headers: { 'content-type': 'text/html' },
      body: Buffer.from(`<iframe src="https://next.example.test/e/1?x=1#fragment">
        <iframe src="https://next.example.test/e/1?x=1#other">
        <iframe src="https://sub.next.example.test/e/2">
        <iframe src="https://fake-next.example.test.invalid/e/3">
        <video src="https://media.example.test/master.m3u8">`) }; } },
    directHlsResolver: { resolve: async (input) => { hlsCalls += 1; return [{
      url: input.url, protocol: 'hls', providerId: input.providerId,
      resolverId: 'direct_hls', headers: {}, validated: true,
    }]; } },
  });
  const input = candidate('https://embed.example.test/e/a', {
    headers: { authorization: 'Bearer must-not-propagate', cookie: 'private' },
  });
  const node = await resolver.resolveNode(input);
  assert.equal(pageCalls, 1);
  assert.equal(hlsCalls, 1);
  assert.equal(node.streams.length, 1);
  assert.equal(node.nextCandidates.length, 2);
  assert.deepEqual(node.nextCandidates[0], { providerId: 'html_source',
    url: 'https://next.example.test/e/1?x=1',
    referer: 'https://embed.example.test/e/a', origin: 'https://embed.example.test',
    headers: {}, languageHint: null, qualityHint: null,
    metadata: { discoveryType: 'iframe', sourceType: 'configured_html_resolver' } });
  assert.equal(node.nextCandidates[1].url, 'https://sub.next.example.test/e/2');
  assert.doesNotMatch(JSON.stringify(node.nextCandidates), /authorization|cookie|must-not/i);
  assert.equal((await resolver.resolve(input)).length, 1);
  assert.equal(pageCalls, 2);
});

test('nested chaining is disabled by default and unsafe allowlists fail closed', async () => {
  const html = { get: async () => ({ ok: true, url: 'https://embed.example.test/e',
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<iframe src="https://next.example.test/e">') }) };
  const directHlsResolver = { resolve: async () => [] };
  const resolver = createConfiguredHtmlResolver({ id: 'x', enabled: true,
    domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'],
    http: html, directHlsResolver });
  assert.deepEqual((await resolver.resolveNode(candidate('https://embed.example.test/e')))
    .nextCandidates, []);
  for (const domain of ['*', '127.0.0.1', 'localhost', 'x.localhost',
    'https://next.example.test', 'next.example.test:443', 'next.example.test/path']) {
    const unsafe = createConfiguredHtmlResolver({ id: 'x', enabled: true,
      domains: ['embed.example.test'], allowedMediaDomains: ['media.example.test'],
      allowedNestedDomains: [domain], http: html, directHlsResolver });
    assert.equal(unsafe.descriptor.active, false);
  }
});

test('resolver module is static HTTP only and never imports legacy/browser transports', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'resolvers', 'configuredHtmlResolver.js'), 'utf8');
  assert.doesNotMatch(text, /ProviderC|linkExtractor|puppeteer|playwright|browserSlots|ResolverExecutor|streamResolverChild|child_process|node:vm|\beval\s*\(|new Function|require\(['"]node:https?['"]\)/i);
});
