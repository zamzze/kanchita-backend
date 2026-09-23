'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const tls = require('node:tls');
const { createSafeHttpClient } = require('../../http/safeHttpClient');

const HOST = 'peertube.cpy.re';
const ABOUT_PATH = '/api/v1/config/about';
const ITEM_PATH = '/api/v1/videos/7bc04dcc-1bde-4350-99a2-8d67fc1534e5';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 4000;
const NODE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

const bounded = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { const error = new Error('TIMEOUT');
    error.code = 'TIMEOUT'; reject(error); }, timeoutMs);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); });
});

const dnsProbe = async (host, timeoutMs) => {
  try {
    const addresses = await bounded(dns.lookup(host, { all: true, verbatim: true }), timeoutMs);
    return { dnsResolved: addresses.length > 0,
      ipv4Available: addresses.some((entry) => entry.family === 4),
      ipv6Available: addresses.some((entry) => entry.family === 6),
      addressCount: addresses.length,
      ...(addresses.length ? {} : { errorCode: 'DNS_NOT_FOUND' }) };
  } catch (error) {
    return { dnsResolved: false, ipv4Available: false, ipv6Available: false,
      addressCount: 0, errorCode: error?.code === 'TIMEOUT' ? 'DNS_TIMEOUT'
        : error?.code === 'ENOTFOUND' || error?.code === 'ENODATA' ? 'DNS_NOT_FOUND'
          : 'DNS_ERROR' };
  }
};

const tlsProbe = (host, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  let connected = false;
  const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };
  const timer = setTimeout(() => finish({ tcpConnected: connected, tlsEstablished: false,
    certificateAuthorized: false, tlsProtocol: null,
    errorCode: connected ? 'TLS_HANDSHAKE_ERROR' : 'TCP_TIMEOUT' }), timeoutMs);
  socket.once('connect', () => { connected = true; });
  socket.once('secureConnect', () => finish({ tcpConnected: true, tlsEstablished: true,
    certificateAuthorized: socket.authorized === true, tlsProtocol: socket.getProtocol() || null }));
  socket.once('error', (error) => finish({ tcpConnected: connected,
    tlsEstablished: false, certificateAuthorized: false, tlsProtocol: null,
    errorCode: /^(?:CERT_|ERR_TLS_CERT_|UNABLE_TO_VERIFY_|DEPTH_ZERO_)/.test(error?.code || '')
      ? 'TLS_CERTIFICATE_ERROR' : connected ? 'TLS_HANDSHAKE_ERROR'
        : 'TCP_CONNECTION_ERROR' }));
});

const nativeGet = (host, path, timeoutMs, maxBytes = MAX_BYTES) => new Promise((resolve) => {
  const started = Date.now();
  let settled = false;
  let request;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request?.destroy();
    resolve({ ...result, durationMs: Math.max(0, Date.now() - started) });
  };
  const timer = setTimeout(() => finish({ succeeded: false,
    errorCode: 'NATIVE_HTTP_TIMEOUT' }), timeoutMs);
  try {
    request = https.request({ hostname: host, port: 443, path, method: 'GET',
      agent: false, rejectUnauthorized: true, headers: { accept: 'application/json' } },
    (response) => {
      let bytes = 0;
      const status = response.statusCode || 0;
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) finish({ succeeded: false, status, bytes: maxBytes,
          errorCode: 'NATIVE_HTTP_BODY_LIMIT', contentTypeCompatible: false });
      });
      response.once('end', () => finish({ succeeded: true, status, bytes,
        contentTypeCompatible: contentType.startsWith('application/json') }));
      response.once('error', () => finish({ succeeded: false, status,
        errorCode: 'NATIVE_HTTP_CONNECTION_ERROR' }));
    });
    request.once('error', (error) => finish({ succeeded: false,
      errorCode: NODE_CODES.has(error?.code) ? error.code : 'NATIVE_HTTP_CONNECTION_ERROR' }));
    request.end();
  } catch {
    finish({ succeeded: false, errorCode: 'NATIVE_HTTP_CONNECTION_ERROR' });
  }
});

const safeGet = async (host, path, timeoutMs, maxBytes = MAX_BYTES) => {
  const started = Date.now();
  try {
    const result = await createSafeHttpClient({ timeoutMs, maxBytes, maxRedirects: 0 })
      .get(`https://${host}${path}`, { timeoutMs, maxBytes, maxRedirects: 0 });
    return { succeeded: true, status: result.status,
      durationMs: Math.max(0, Date.now() - started) };
  } catch (error) {
    return { succeeded: false,
      errorCode: /^HTTP_[A-Z_]+$/.test(error?.code || '') ? error.code : 'HTTP_CONNECTION_ERROR',
      durationMs: Math.max(0, Date.now() - started) };
  }
};

const createPublicConnectivityDiagnosis = ({ host = HOST, timeoutMs = TIMEOUT_MS,
  lookup = dnsProbe, connectTls = tlsProbe, getNative = nativeGet,
  getSafe = safeGet, now = Date.now } = {}) => {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      [lookup, connectTls, getNative, getSafe, now].some((value) => typeof value !== 'function')) {
    throw new Error('CONNECTIVITY_DIAGNOSIS_INVALID_CONFIG');
  }
  const run = async () => {
    const started = now();
    const result = { status: 'CONNECTIVITY_DIAGNOSED', host,
      dnsResolved: false, ipv4Available: false, ipv6Available: false, addressCount: 0,
      tcpConnected: false, tlsEstablished: false, certificateAuthorized: false,
      tlsProtocol: null, nativeHttpConnected: false, nativeHttpStatus: null,
      nativeHttpBytes: 0, nativeHttpDurationMs: null, nativeExactItemStatus: null,
      contentTypeCompatible: false, bodyReceived: false, nativeExactItemBytes: 0,
      safeHttpSucceeded: false, safeHttpStatus: null, safeHttpErrorCode: null,
      safeHttpDurationMs: null, rootCauseLayer: 'UNKNOWN', rootCauseCode: 'UNKNOWN' };
    const finish = (layer, code) => Object.freeze({ ...result, rootCauseLayer: layer,
      rootCauseCode: code, durationMs: Math.max(0, now() - started) });
    const dnsResult = await lookup(host, timeoutMs);
    Object.assign(result, { dnsResolved: dnsResult.dnsResolved === true,
      ipv4Available: dnsResult.ipv4Available === true,
      ipv6Available: dnsResult.ipv6Available === true,
      addressCount: Number.isInteger(dnsResult.addressCount) ? dnsResult.addressCount : 0 });
    if (!result.dnsResolved) return finish('DNS', dnsResult.errorCode || 'DNS_ERROR');

    const tlsResult = await connectTls(host, timeoutMs);
    Object.assign(result, { tcpConnected: tlsResult.tcpConnected === true,
      tlsEstablished: tlsResult.tlsEstablished === true,
      certificateAuthorized: tlsResult.certificateAuthorized === true,
      tlsProtocol: typeof tlsResult.tlsProtocol === 'string' ? tlsResult.tlsProtocol : null });
    if (!result.tcpConnected) return finish('TCP', tlsResult.errorCode || 'TCP_CONNECTION_ERROR');
    if (!result.tlsEstablished || !result.certificateAuthorized) {
      return finish('TLS', tlsResult.errorCode || 'TLS_HANDSHAKE_ERROR');
    }

    const native = await getNative(host, ABOUT_PATH, timeoutMs);
    Object.assign(result, { nativeHttpConnected: native.succeeded === true,
      nativeHttpStatus: Number.isInteger(native.status) ? native.status : null,
      nativeHttpBytes: Number.isInteger(native.bytes) ? native.bytes : 0,
      nativeHttpDurationMs: Number.isFinite(native.durationMs) ? native.durationMs : null });
    if (!native.succeeded) return finish('NATIVE_HTTP', native.errorCode || 'NATIVE_HTTP_FAILURE');
    if (native.status < 200 || native.status >= 300) {
      return finish('ENDPOINT_HTTP', 'ENDPOINT_HTTP_ERROR');
    }

    const exact = await getNative(host, ITEM_PATH, timeoutMs);
    Object.assign(result, { nativeExactItemStatus: Number.isInteger(exact.status)
      ? exact.status : null, contentTypeCompatible: exact.contentTypeCompatible === true,
    bodyReceived: Number.isInteger(exact.bytes) && exact.bytes > 0,
    nativeExactItemBytes: Number.isInteger(exact.bytes) ? exact.bytes : 0 });
    if (!exact.succeeded) return finish('NATIVE_HTTP', exact.errorCode || 'NATIVE_HTTP_FAILURE');
    if (exact.status < 200 || exact.status >= 300) {
      return finish('ENDPOINT_HTTP', 'ENDPOINT_HTTP_ERROR');
    }

    const safe = await getSafe(host, ITEM_PATH, timeoutMs);
    Object.assign(result, { safeHttpSucceeded: safe.succeeded === true,
      safeHttpStatus: Number.isInteger(safe.status) ? safe.status : null,
      safeHttpErrorCode: typeof safe.errorCode === 'string' ? safe.errorCode : null,
      safeHttpDurationMs: Number.isFinite(safe.durationMs) ? safe.durationMs : null });
    if (!safe.succeeded) return finish('SAFE_HTTP_CLIENT', safe.errorCode || 'HTTP_CONNECTION_ERROR');
    if (safe.status < 200 || safe.status >= 300) {
      return finish('ENDPOINT_HTTP', 'ENDPOINT_HTTP_ERROR');
    }
    return finish('NONE', 'CONNECTIVITY_OK');
  };
  return Object.freeze({ run });
};

const formatPublicConnectivityDiagnosis = (result, json = false) => json
  ? JSON.stringify(result)
  : Object.entries(result).map(([key, value]) => `${key}=${value ?? 'null'}`).join('\n');

module.exports = { HOST, ABOUT_PATH, ITEM_PATH, createPublicConnectivityDiagnosis,
  formatPublicConnectivityDiagnosis };
