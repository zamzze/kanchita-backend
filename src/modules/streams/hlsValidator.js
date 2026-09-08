'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const {
  isPublicIp,
  parseHttpUrl,
  resolveDestination: resolveSafeDestination,
  pinnedLookup,
  withDeadline: withSafeDeadline,
} = require('./http/safeNetwork');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const validationError = (code) => {
  const error = new Error(code);
  error.validationCode = code;
  return error;
};

const resolveDestination = async (url, {
  dnsLookup = dns.lookup,
  allowPrivateNetworks = false,
} = {}) => {
  try {
    return await resolveSafeDestination(url, {
      dnsLookup,
      allowPrivateNetworks,
      unsafeCode: 'HLS_UNSAFE_DESTINATION',
    });
  } catch (error) {
    throw validationError(error.code || 'HLS_UNSAFE_DESTINATION');
  }
};

const requestManifest = (url, { addresses, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const request = transport.request(url, {
      method: 'GET',
      agent: false,
      lookup: pinnedLookup(addresses),
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.8',
      },
    });

    timeout = setTimeout(() => {
      request.destroy(validationError('HLS_TIMEOUT'));
    }, timeoutMs);
    request.on('error', (error) => finish(reject, error));
    request.on('response', (response) => {
      const location = response.headers.location || null;
      if (REDIRECT_STATUSES.has(response.statusCode) ||
          response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        finish(resolve, { status: response.statusCode, location, body: null });
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        finish(reject, validationError('HLS_TOO_LARGE'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(validationError('HLS_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode,
        location,
        body: Buffer.concat(chunks, total),
      }));
      response.on('error', (error) => finish(reject, error));
    });
    request.end();
  });

const withDeadline = async (promise, timeoutMs) => {
  try {
    return await withSafeDeadline(promise, timeoutMs, { timeoutCode: 'HLS_TIMEOUT' });
  } catch (error) {
    if (error.validationCode) throw error;
    throw validationError(error.code || 'HLS_TIMEOUT');
  }
};

const createHlsValidator = ({
  timeoutMs = 5000,
  maxBytes = 256 * 1024,
  maxRedirects = 3,
  dnsLookup = dns.lookup,
  requestImpl = requestManifest,
  allowPrivateNetworks = false,
  includeManifest = false,
} = {}) => async (candidate) => {
  let currentUrl = parseHttpUrl(candidate);
  if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };
  const deadline = Date.now() + timeoutMs;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1) throw validationError('HLS_TIMEOUT');
      const addresses = await withDeadline(
        resolveDestination(currentUrl, { dnsLookup, allowPrivateNetworks }),
        remainingMs
      );
      const requestRemainingMs = deadline - Date.now();
      if (requestRemainingMs < 1) throw validationError('HLS_TIMEOUT');
      const response = await requestImpl(currentUrl, {
        addresses,
        timeoutMs: requestRemainingMs,
        maxBytes,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          return { valid: false, code: 'HLS_TOO_MANY_REDIRECTS' };
        }
        if (!response.location) return { valid: false, code: 'HLS_HTTP_ERROR' };
        currentUrl = parseHttpUrl(new URL(response.location, currentUrl).toString());
        if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return { valid: false, code: 'HLS_HTTP_ERROR' };
      }

      const manifest = (response.body || Buffer.alloc(0)).toString('utf8').trimStart();
      if (!manifest.startsWith('#EXTM3U')) {
        return { valid: false, code: 'HLS_INVALID_MANIFEST' };
      }
      return {
        valid: true,
        code: null,
        ...(includeManifest ? { manifest } : {}),
      };
    }
  } catch (error) {
    if (error.validationCode) return { valid: false, code: error.validationCode };
    return { valid: false, code: 'HLS_CONNECTION_ERROR' };
  }
};

module.exports = {
  createHlsValidator,
  isPublicIp,
  parseHttpUrl,
  resolveDestination,
};
