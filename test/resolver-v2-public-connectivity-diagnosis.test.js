'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { HOST, ABOUT_PATH, ITEM_PATH, createPublicConnectivityDiagnosis,
  formatPublicConnectivityDiagnosis } = require(
  '../src/modules/streams/resolverV2/diagnostics/publicConnectivityDiagnosis');

const defaults = () => ({
  lookup: async () => ({ dnsResolved: true, ipv4Available: true,
    ipv6Available: false, addressCount: 1 }),
  connectTls: async () => ({ tcpConnected: true, tlsEstablished: true,
    certificateAuthorized: true, tlsProtocol: 'TLSv1.3' }),
  getNative: async () => ({ succeeded: true, status: 200, bytes: 10,
    durationMs: 2, contentTypeCompatible: true }),
  getSafe: async () => ({ succeeded: true, status: 200, durationMs: 2 }),
  now: () => 100,
});
const run = (overrides = {}) => createPublicConnectivityDiagnosis({
  ...defaults(), ...overrides }).run();

test('DNS failure stops before opening any connection', async () => {
  let called = false;
  const result = await run({ lookup: async () => ({ dnsResolved: false,
    errorCode: 'DNS_NOT_FOUND' }), connectTls: async () => { called = true; } });
  assert.equal(result.rootCauseLayer, 'DNS');
  assert.equal(result.rootCauseCode, 'DNS_NOT_FOUND');
  assert.equal(called, false);
});

test('DNS timeout is distinct from a lookup miss', async () => {
  const result = await run({ lookup: async () => ({ dnsResolved: false,
    errorCode: 'DNS_TIMEOUT' }) });
  assert.equal(result.rootCauseCode, 'DNS_TIMEOUT');
});

test('TCP failure is distinguished from TLS failure', async () => {
  const tcp = await run({ connectTls: async () => ({ tcpConnected: false,
    tlsEstablished: false, errorCode: 'TCP_CONNECTION_ERROR' }) });
  const tls = await run({ connectTls: async () => ({ tcpConnected: true,
    tlsEstablished: false, errorCode: 'TLS_CERTIFICATE_ERROR' }) });
  assert.deepEqual([tcp.rootCauseLayer, tls.rootCauseLayer], ['TCP', 'TLS']);
  assert.equal(tls.rootCauseCode, 'TLS_CERTIFICATE_ERROR');
});

test('native HTTP failure stops before exact item and safe client', async () => {
  const calls = [];
  const result = await run({ getNative: async (_host, requestPath) => {
    calls.push(requestPath);
    return { succeeded: false, errorCode: 'NATIVE_HTTP_TIMEOUT' };
  }, getSafe: async () => { throw new Error('safe client must not run'); } });
  assert.deepEqual(calls, [ABOUT_PATH]);
  assert.equal(result.rootCauseLayer, 'NATIVE_HTTP');
  assert.equal(result.rootCauseCode, 'NATIVE_HTTP_TIMEOUT');
});

test('native success followed by safe-client failure exposes the divergence', async () => {
  const calls = [];
  const result = await run({ getNative: async (_host, requestPath) => {
    calls.push(requestPath);
    return { succeeded: true, status: 200, bytes: 9, durationMs: 1,
      contentTypeCompatible: true };
  }, getSafe: async (_host, requestPath) => {
    calls.push(requestPath);
    return { succeeded: false, errorCode: 'HTTP_CONNECTION_ERROR', durationMs: 1 };
  } });
  assert.deepEqual(calls, [ABOUT_PATH, ITEM_PATH, ITEM_PATH]);
  assert.equal(result.nativeHttpConnected, true);
  assert.equal(result.safeHttpSucceeded, false);
  assert.equal(result.rootCauseLayer, 'SAFE_HTTP_CLIENT');
  assert.equal(result.rootCauseCode, 'HTTP_CONNECTION_ERROR');
});

test('safe destination rejection is reported without relaxing SSRF', async () => {
  const result = await run({ getSafe: async () => ({ succeeded: false,
    errorCode: 'HTTP_UNSAFE_DESTINATION' }) });
  assert.equal(result.rootCauseLayer, 'SAFE_HTTP_CLIENT');
  assert.equal(result.safeHttpErrorCode, 'HTTP_UNSAFE_DESTINATION');
});

test('endpoint HTTP error is distinct from transport error', async () => {
  const result = await run({ getNative: async () => ({ succeeded: true,
    status: 503, bytes: 0, durationMs: 1 }) });
  assert.equal(result.rootCauseLayer, 'ENDPOINT_HTTP');
  assert.equal(result.rootCauseCode, 'ENDPOINT_HTTP_ERROR');
  assert.equal(result.nativeExactItemStatus, null);
});

test('exact item error is classified without calling SafeHttpClient', async () => {
  let count = 0;
  const result = await run({ getNative: async () => {
    count += 1;
    return { succeeded: true, status: count === 1 ? 200 : 404,
      bytes: 2, durationMs: 1 };
  }, getSafe: async () => { throw new Error('unexpected safe request'); } });
  assert.equal(result.nativeExactItemStatus, 404);
  assert.equal(result.rootCauseLayer, 'ENDPOINT_HTTP');
});

test('complete success has deterministic fields and ordering', async () => {
  const first = await run();
  const second = await run();
  assert.deepEqual(first, second);
  assert.equal(first.host, HOST);
  assert.equal(first.rootCauseLayer, 'NONE');
  assert.equal(first.rootCauseCode, 'CONNECTIVITY_OK');
  assert.equal(first.safeHttpStatus, 200);
  assert.equal(first.durationMs, 0);
  assert.equal(Object.isFrozen(first), true);
});

test('text and JSON output are sanitized and diagnostics never import provider runtime', async () => {
  const result = await run();
  const text = formatPublicConnectivityDiagnosis(result);
  const json = formatPublicConnectivityDiagnosis(result, true);
  assert.match(text, /host=peertube\.cpy\.re/);
  assert.doesNotMatch(`${text}${json}`, /api\/v1|7bc04dcc|https:\/\/|cookie|authorization|body:/i);
  const code = fs.readFileSync(path.resolve(__dirname,
    '../src/modules/streams/resolverV2/diagnostics/publicConnectivityDiagnosis.js'), 'utf8');
  assert.doesNotMatch(code, /ProviderC|puppeteer|catalogProviderSmoke|rejectUnauthorized:\s*false/);
});
