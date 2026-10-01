'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const {
  createSafeHttpClient,
  bodyText,
  DEFAULT_USER_AGENT,
} = require('../src/modules/streams/http/safeHttpClient');

let firstServer;
let secondServer;
let firstUrl;
let secondUrl;

const readRequestBody = (request) => new Promise((resolve) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});
const rejectsWithCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

before(async () => {
  secondServer = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ method: request.method, headers: request.headers, body }));
  });
  await listen(secondServer);
  secondUrl = `http://127.0.0.1:${secondServer.address().port}`;

  firstServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    const route = url.pathname;
    if (route === '/get') return response.end('fixture-ok');
    if (route === '/head') {
      response.setHeader('x-head', 'yes');
      return response.end('body-must-not-be-returned');
    }
    if (route === '/echo' || route === '/method') {
      const body = await readRequestBody(request);
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ method: request.method, body }));
    }
    if (route === '/headers') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(request.headers));
    }
    if (route === '/response-headers') {
      response.setHeader('x-fixture', 'available');
      response.setHeader('set-cookie', ['fixture=a; HttpOnly', 'theme=dark']);
      return response.end('headers');
    }
    if (route === '/declared-large') {
      response.setHeader('content-length', '4096');
      return response.end('small');
    }
    if (route === '/stream-large') {
      response.write('a'.repeat(700));
      return response.end('b'.repeat(700));
    }
    if (route === '/redirect-absolute') {
      response.writeHead(302, { Location: `${firstUrl}/get` });
      return response.end();
    }
    if (route === '/redirect-relative') {
      response.writeHead(302, { Location: '/get' });
      return response.end();
    }
    if (route === '/redirect-sensitive') {
      response.writeHead(302, { Location: `${secondUrl}/capture` });
      return response.end();
    }
    if (route === '/redirect-blocked') {
      response.writeHead(302, { Location: 'http://10.0.0.1/private' });
      return response.end();
    }
    if (route === '/redirect-missing-location') {
      response.writeHead(302);
      return response.end();
    }
    if (route.startsWith('/status/')) {
      response.writeHead(Number(route.split('/').pop()));
      return response.end('status-body');
    }
    if (route.startsWith('/method-redirect/')) {
      response.writeHead(Number(route.split('/').pop()), { Location: '/method' });
      return response.end();
    }
    if (route === '/chain') {
      const step = Number(url.searchParams.get('step') || 0);
      const delay = Number(url.searchParams.get('delay') || 0);
      return setTimeout(() => {
        if (step >= 3) return response.end('chain-complete');
        response.writeHead(302, { Location: `/chain?step=${step + 1}&delay=${delay}` });
        return response.end();
      }, delay);
    }
    if (route === '/slow-headers') return setTimeout(() => response.end('late'), 150);
    if (route === '/slow-body') {
      response.write('first');
      return setTimeout(() => response.end('last'), 150);
    }
    response.writeHead(404);
    return response.end('missing');
  });
  await listen(firstServer);
  firstUrl = `http://127.0.0.1:${firstServer.address().port}`;
});

after(async () => {
  await Promise.all([close(firstServer), close(secondServer)]);
});

const localClient = (options = {}) => createSafeHttpClient({
  allowPrivateNetworks: true,
  timeoutMs: 500,
  ...options,
});

test('GET, HEAD and POST return the normalized response contract', async () => {
  const client = localClient();
  const get = await client.get(`${firstUrl}/get`);
  assert.equal(get.ok, true);
  assert.equal(get.status, 200);
  assert.equal(get.url, `${firstUrl}/get`);
  assert.equal(Buffer.isBuffer(get.body), true);
  assert.equal(bodyText(get), 'fixture-ok');
  assert.equal(get.redirects, 0);
  assert.ok(get.latencyMs >= 0);

  const head = await client.head(`${firstUrl}/head`);
  assert.equal(head.headers['x-head'], 'yes');
  assert.deepEqual(head.body, Buffer.alloc(0));

  for (const body of ['text', Buffer.from('buffer'), new Uint8Array([98, 121, 116, 101, 115])]) {
    const post = await client.post(`${firstUrl}/echo`, { body });
    const echoed = JSON.parse(bodyText(post));
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, Buffer.from(body).toString());
  }
});

test('request and response headers remain available without hidden cookie state', async () => {
  const client = localClient();
  const custom = await client.get(`${firstUrl}/headers`, { headers: {
    'User-Agent': 'Fixture-Agent/2', Referer: 'https://referer.example.test/',
    Origin: 'https://origin.example.test', Range: 'bytes=0-99', 'X-Test': 'present',
  } });
  const headers = JSON.parse(bodyText(custom));
  assert.equal(headers['user-agent'], 'Fixture-Agent/2');
  assert.equal(headers.referer, 'https://referer.example.test/');
  assert.equal(headers.origin, 'https://origin.example.test');
  assert.equal(headers.range, 'bytes=0-99');
  assert.equal(headers['x-test'], 'present');
  assert.equal(headers['accept-encoding'], 'identity');

  const defaults = JSON.parse(bodyText(await client.get(`${firstUrl}/headers`)));
  assert.equal(defaults['user-agent'], DEFAULT_USER_AGENT);
  const response = await client.get(`${firstUrl}/response-headers`);
  assert.equal(response.headers['x-fixture'], 'available');
  assert.deepEqual(response.headers['set-cookie'], ['fixture=a; HttpOnly', 'theme=dark']);
});

test('body limits reject declared and streamed overflow', async () => {
  const client = localClient();
  await rejectsWithCode(client.get(`${firstUrl}/declared-large`, { maxBytes: 1000 }),
    'HTTP_RESPONSE_TOO_LARGE');
  await rejectsWithCode(client.get(`${firstUrl}/stream-large`, { maxBytes: 1000 }),
    'HTTP_RESPONSE_TOO_LARGE');
});

test('absolute and relative redirects expose the final URL and count', async () => {
  const client = localClient();
  for (const route of ['/redirect-absolute', '/redirect-relative']) {
    const response = await client.get(`${firstUrl}${route}`);
    assert.equal(response.url, `${firstUrl}/get`);
    assert.equal(response.redirects, 1);
    assert.equal(bodyText(response), 'fixture-ok');
  }
});

test('redirect method semantics cover 301, 302, 303, 307 and 308', async () => {
  const client = localClient();
  for (const status of [301, 302, 303]) {
    const response = await client.post(`${firstUrl}/method-redirect/${status}`, {
      headers: { 'Content-Type': 'text/plain' }, body: 'payload',
    });
    assert.deepEqual(JSON.parse(bodyText(response)), { method: 'GET', body: '' });
  }
  for (const status of [307, 308]) {
    const response = await client.post(`${firstUrl}/method-redirect/${status}`, {
      headers: { 'Content-Type': 'text/plain' }, body: 'payload',
    });
    assert.deepEqual(JSON.parse(bodyText(response)), { method: 'POST', body: 'payload' });
  }
});

test('redirect limit, missing Location and blocked destination return stable codes', async () => {
  const client = localClient();
  await rejectsWithCode(client.get(`${firstUrl}/chain`, { maxRedirects: 1 }),
    'HTTP_TOO_MANY_REDIRECTS');
  await rejectsWithCode(client.get(`${firstUrl}/redirect-missing-location`),
    'HTTP_REDIRECT_ERROR');
  await rejectsWithCode(createSafeHttpClient().get(`${firstUrl}/get`),
    'HTTP_UNSAFE_DESTINATION');
  await rejectsWithCode(client.get(`${firstUrl}/redirect-blocked`, {
    allowPrivateNetworks: false,
  }), 'HTTP_UNSAFE_DESTINATION');
});

test('4xx and 5xx statuses are normal non-ok responses', async () => {
  for (const status of [404, 500]) {
    const response = await localClient().get(`${firstUrl}/status/${status}`);
    assert.equal(response.ok, false);
    assert.equal(response.status, status);
    assert.equal(bodyText(response), 'status-body');
  }
});

test('sensitive headers do not cross origins while ordinary headers may', async () => {
  const response = await localClient().get(`${firstUrl}/redirect-sensitive`, { headers: {
    Authorization: 'Bearer synthetic-secret', Cookie: 'fixture=secret',
    Referer: 'https://private.example.test/path', Origin: 'https://private.example.test',
    'X-Test': 'safe',
  } });
  const captured = JSON.parse(bodyText(response)).headers;
  assert.equal(captured.authorization, undefined);
  assert.equal(captured.cookie, undefined);
  assert.equal(captured.referer, undefined);
  assert.equal(captured.origin, undefined);
  assert.equal(captured['x-test'], 'safe');
});

test('timeout is one global deadline across DNS, redirects and body', async () => {
  const client = localClient({ timeoutMs: 65 });
  const startedAt = Date.now();
  await rejectsWithCode(client.get(`${firstUrl}/chain?delay=25`), 'HTTP_TIMEOUT');
  assert.ok(Date.now() - startedAt < 160);
  await rejectsWithCode(client.get(`${firstUrl}/slow-headers`, { timeoutMs: 30 }), 'HTTP_TIMEOUT');
  await rejectsWithCode(client.get(`${firstUrl}/slow-body`, { timeoutMs: 30 }), 'HTTP_TIMEOUT');
});

test('AbortSignal cancels before and during a request', async () => {
  const client = localClient();
  const preAborted = new AbortController();
  preAborted.abort();
  await rejectsWithCode(client.get(`${firstUrl}/get`, { signal: preAborted.signal }),
    'HTTP_ABORTED');

  const active = new AbortController();
  const pending = client.get(`${firstUrl}/slow-body`, { signal: active.signal });
  setTimeout(() => active.abort(), 15);
  await rejectsWithCode(pending, 'HTTP_ABORTED');
});

test('invalid URL, credentials, method, headers and body fail predictably', async () => {
  const client = localClient();
  await rejectsWithCode(client.get('not a URL'), 'HTTP_INVALID_URL');
  await rejectsWithCode(client.get('http://user:secret@127.0.0.1/'), 'HTTP_INVALID_URL');
  await rejectsWithCode(client.request('G ET', `${firstUrl}/get`), 'HTTP_INVALID_METHOD');
  await rejectsWithCode(client.get(`${firstUrl}/get`, { headers: { X: 1 } }),
    'HTTP_INVALID_HEADERS');
  await rejectsWithCode(client.post(`${firstUrl}/echo`, { body: { value: 1 } }),
    'HTTP_INVALID_BODY');
});
