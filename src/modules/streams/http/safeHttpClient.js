'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const {
  parseHttpUrl,
  resolveDestination,
  pinnedLookup,
  withDeadline,
  networkError,
} = require('./safeNetwork');

const DEFAULT_USER_AGENT = 'Kanchita-HTTP-Resolver/1.0';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'referer', 'origin',
]);

const clientError = (code) => networkError(code);

const positiveInteger = (value, fallback) =>
  Number.isInteger(value) && value > 0 ? value : fallback;

const nonNegativeInteger = (value, fallback) =>
  Number.isInteger(value) && value >= 0 ? value : fallback;

const normalizeRequestHeaders = (input) => {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw clientError('HTTP_INVALID_HEADERS');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw clientError('HTTP_INVALID_HEADERS');
  }
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (typeof rawValue !== 'string' || !rawName.trim() || /[\r\n]/.test(rawName + rawValue)) {
      throw clientError('HTTP_INVALID_HEADERS');
    }
    headers[rawName.trim().toLowerCase()] = rawValue;
  }
  return headers;
};

const normalizeResponseHeaders = (headers) => Object.fromEntries(
  Object.entries(headers).filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name.toLowerCase(), value])
);

const normalizeBody = (body) => {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw clientError('HTTP_INVALID_BODY');
};

const normalizeMethod = (method) => {
  if (typeof method !== 'string') throw clientError('HTTP_INVALID_METHOD');
  const normalized = method.trim().toUpperCase();
  if (!normalized || !/^[A-Z]+$/.test(normalized)) throw clientError('HTTP_INVALID_METHOD');
  return normalized;
};

const defaultRequestImpl = (url, options, onResponse) =>
  (url.protocol === 'https:' ? https : http).request(url, options, onResponse);

const createSafeHttpClient = ({
  timeoutMs: defaultTimeoutMs = 12_000,
  maxBytes: defaultMaxBytes = 1024 * 1024,
  maxRedirects: defaultMaxRedirects = 4,
  userAgent = DEFAULT_USER_AGENT,
  allowPrivateNetworks: defaultAllowPrivateNetworks = false,
  dnsLookup = dns.lookup,
  requestImpl = defaultRequestImpl,
  now = Date.now,
} = {}) => {
  const performSingleRequest = (url, {
    method,
    headers,
    body,
    addresses,
    remainingMs,
    maxBytes,
    signal,
  }) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(clientError('HTTP_ABORTED'));
    let settled = false;
    let request;
    let response;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const destroy = (error) => {
      response?.destroy(error);
      request?.destroy(error);
    };
    const fail = (error) => {
      destroy(error);
      finish(reject, error);
    };
    const onAbort = () => fail(clientError('HTTP_ABORTED'));
    const timer = setTimeout(() => fail(clientError('HTTP_TIMEOUT')), remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      request = requestImpl(url, {
        method,
        headers,
        agent: false,
        lookup: pinnedLookup(addresses),
      }, (incoming) => {
        response = incoming;
        const status = Number(incoming.statusCode) || 0;
        const responseHeaders = normalizeResponseHeaders(incoming.headers);

        if (method === 'HEAD') {
          incoming.destroy();
          finish(resolve, { status, headers: responseHeaders, body: Buffer.alloc(0) });
          return;
        }

        const declaredLength = Number(incoming.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          fail(clientError('HTTP_RESPONSE_TOO_LARGE'));
          return;
        }

        const chunks = [];
        let total = 0;
        incoming.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            fail(clientError('HTTP_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => finish(resolve, {
          status,
          headers: responseHeaders,
          body: Buffer.concat(chunks, total),
        }));
        incoming.on('error', (error) => {
          if (settled) return;
          finish(reject, error?.code?.startsWith('HTTP_')
            ? error : clientError('HTTP_CONNECTION_ERROR'));
        });
      });
    } catch {
      fail(clientError('HTTP_CONNECTION_ERROR'));
      return;
    }

    request.on('error', (error) => {
      if (settled) return;
      finish(reject, error?.code?.startsWith('HTTP_')
        ? error : clientError('HTTP_CONNECTION_ERROR'));
    });
    if (body) request.write(body);
    request.end();
  });

  const performSingleStreamingRequest = (url, {
    method, headers, addresses, remainingMs, signal,
  }) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(clientError('HTTP_ABORTED'));
    let settled = false;
    let request;
    let response;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      response?.destroy(error);
      request?.destroy(error);
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const onAbort = () => fail(clientError('HTTP_ABORTED'));
    const timer = setTimeout(() => fail(clientError('HTTP_TIMEOUT')), remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request = requestImpl(url, {
        method, headers, agent: false, lookup: pinnedLookup(addresses),
      }, (incoming) => {
        response = incoming;
        const status = Number(incoming.statusCode) || 0;
        const responseHeaders = normalizeResponseHeaders(incoming.headers);
        if (!settled) {
          settled = true;
          incoming.once('end', cleanup);
          incoming.once('close', cleanup);
          resolve({ status, headers: responseHeaders, body: incoming,
            abort: () => request.destroy(clientError('HTTP_ABORTED')) });
        }
      });
    } catch {
      fail(clientError('HTTP_CONNECTION_ERROR'));
      return;
    }
    request.once('error', (error) => {
      if (!settled) fail(error?.code?.startsWith('HTTP_')
        ? error : clientError('HTTP_CONNECTION_ERROR'));
    });
    request.end();
  });

  const request = async (rawMethod, rawUrl, options = {}) => {
    const startedAt = now();
    const method = normalizeMethod(rawMethod);
    const initialUrl = parseHttpUrl(rawUrl);
    if (!initialUrl) throw clientError('HTTP_INVALID_URL');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw clientError('HTTP_INVALID_HEADERS');
    }

    const timeoutMs = positiveInteger(options.timeoutMs, positiveInteger(defaultTimeoutMs, 12_000));
    const maxBytes = positiveInteger(options.maxBytes, positiveInteger(defaultMaxBytes, 1024 * 1024));
    const maxRedirects = nonNegativeInteger(
      options.maxRedirects,
      nonNegativeInteger(defaultMaxRedirects, 4)
    );
    const allowPrivateNetworks = options.allowPrivateNetworks ?? defaultAllowPrivateNetworks;
    if (typeof allowPrivateNetworks !== 'boolean') throw clientError('HTTP_UNSAFE_DESTINATION');
    const signal = options.signal || null;
    if (signal?.aborted) throw clientError('HTTP_ABORTED');

    let currentUrl = initialUrl;
    let currentMethod = method;
    let currentBody = normalizeBody(options.body);
    let currentHeaders = normalizeRequestHeaders(options.headers);
    if (!currentHeaders['user-agent']) currentHeaders['user-agent'] = userAgent;
    if (!currentHeaders['accept-encoding']) currentHeaders['accept-encoding'] = 'identity';
    if (currentBody && !currentHeaders['content-length']) {
      currentHeaders['content-length'] = String(currentBody.length);
    }
    const deadline = startedAt + timeoutMs;

    for (let redirects = 0; ; redirects += 1) {
      let remainingMs = deadline - now();
      if (remainingMs < 1) throw clientError('HTTP_TIMEOUT');
      const addresses = await withDeadline(
        resolveDestination(currentUrl, {
          dnsLookup,
          allowPrivateNetworks,
          unsafeCode: 'HTTP_UNSAFE_DESTINATION',
        }),
        remainingMs,
        { signal }
      );
      if (signal?.aborted) throw clientError('HTTP_ABORTED');
      remainingMs = deadline - now();
      if (remainingMs < 1) throw clientError('HTTP_TIMEOUT');
      const response = await performSingleRequest(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        addresses,
        remainingMs,
        maxBytes,
        signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          url: currentUrl.toString(),
          headers: response.headers,
          body: response.body,
          redirects,
          latencyMs: Math.max(0, now() - startedAt),
        };
      }

      if (redirects >= maxRedirects) throw clientError('HTTP_TOO_MANY_REDIRECTS');
      const location = response.headers.location;
      if (typeof location !== 'string' || !location) throw clientError('HTTP_REDIRECT_ERROR');
      let nextUrl;
      try {
        nextUrl = parseHttpUrl(new URL(location, currentUrl).toString());
      } catch {
        nextUrl = null;
      }
      if (!nextUrl) throw clientError('HTTP_REDIRECT_ERROR');

      if (currentUrl.origin !== nextUrl.origin) {
        currentHeaders = Object.fromEntries(Object.entries(currentHeaders)
          .filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name)));
      }
      if (response.status === 303 && currentMethod !== 'HEAD' ||
          (response.status === 301 || response.status === 302) && currentMethod === 'POST') {
        currentMethod = 'GET';
        currentBody = null;
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
      }
      currentUrl = nextUrl;
    }
  };

  const stream = async (rawUrl, options = {}) => {
    const startedAt = now();
    const initialUrl = parseHttpUrl(rawUrl);
    if (!initialUrl) throw clientError('HTTP_INVALID_URL');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw clientError('HTTP_INVALID_HEADERS');
    }
    const timeoutMs = positiveInteger(options.timeoutMs, positiveInteger(defaultTimeoutMs, 12_000));
    const maxRedirects = nonNegativeInteger(options.maxRedirects,
      nonNegativeInteger(defaultMaxRedirects, 4));
    const allowPrivateNetworks = options.allowPrivateNetworks ?? defaultAllowPrivateNetworks;
    if (typeof allowPrivateNetworks !== 'boolean') throw clientError('HTTP_UNSAFE_DESTINATION');
    const signal = options.signal || null;
    if (signal?.aborted) throw clientError('HTTP_ABORTED');
    let currentUrl = initialUrl;
    let currentHeaders = normalizeRequestHeaders(options.headers);
    if (!currentHeaders['user-agent']) currentHeaders['user-agent'] = userAgent;
    if (!currentHeaders['accept-encoding']) currentHeaders['accept-encoding'] = 'identity';
    const deadline = startedAt + timeoutMs;
    for (let redirects = 0; ; redirects += 1) {
      let remainingMs = deadline - now();
      if (remainingMs < 1) throw clientError('HTTP_TIMEOUT');
      const addresses = await withDeadline(resolveDestination(currentUrl, {
        dnsLookup, allowPrivateNetworks, unsafeCode: 'HTTP_UNSAFE_DESTINATION',
      }), remainingMs, { signal });
      remainingMs = deadline - now();
      if (remainingMs < 1) throw clientError('HTTP_TIMEOUT');
      const response = await performSingleStreamingRequest(currentUrl, {
        method: 'GET', headers: currentHeaders, addresses, remainingMs, signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { ...response, ok: response.status >= 200 && response.status < 300,
          url: currentUrl.toString(), redirects,
          latencyMs: Math.max(0, now() - startedAt) };
      }
      response.body.resume();
      if (redirects >= maxRedirects) throw clientError('HTTP_TOO_MANY_REDIRECTS');
      const location = response.headers.location;
      let nextUrl = null;
      try { nextUrl = parseHttpUrl(new URL(location, currentUrl).toString()); } catch { /* invalid */ }
      if (!nextUrl) throw clientError('HTTP_REDIRECT_ERROR');
      if (currentUrl.origin !== nextUrl.origin) {
        currentHeaders = Object.fromEntries(Object.entries(currentHeaders)
          .filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name)));
      }
      currentUrl = nextUrl;
    }
  };

  return {
    request,
    get: (url, options) => request('GET', url, options),
    head: (url, options) => request('HEAD', url, options),
    post: (url, options) => request('POST', url, options),
    stream,
  };
};

const bodyText = (response, encoding = 'utf8') => response.body.toString(encoding);

module.exports = {
  createSafeHttpClient,
  bodyText,
  DEFAULT_USER_AGENT,
};
