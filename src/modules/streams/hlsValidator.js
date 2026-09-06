'use strict';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const validationError = (code) => {
  const error = new Error(code);
  error.validationCode = code;
  return error;
};

const parseHttpUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const readLimitedBody = async (response, maxBytes, controller) => {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw validationError('HLS_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

const createHlsValidator = ({
  timeoutMs = 5000,
  maxBytes = 256 * 1024,
  maxRedirects = 3,
  fetchImpl = globalThis.fetch,
} = {}) => async (candidate) => {
  let currentUrl = parseHttpUrl(candidate);
  if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.8',
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          response.body?.cancel().catch(() => {});
          return { valid: false, code: 'HLS_TOO_MANY_REDIRECTS' };
        }
        const location = response.headers.get('location');
        response.body?.cancel().catch(() => {});
        if (!location) return { valid: false, code: 'HLS_HTTP_ERROR' };
        currentUrl = parseHttpUrl(new URL(location, currentUrl).toString());
        if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };
        continue;
      }

      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        return { valid: false, code: 'HLS_HTTP_ERROR' };
      }

      const body = await readLimitedBody(response, maxBytes, controller);
      const manifest = body.toString('utf8').trimStart();
      if (!manifest.startsWith('#EXTM3U')) {
        return { valid: false, code: 'HLS_INVALID_MANIFEST' };
      }
      return { valid: true, code: null };
    }
  } catch (error) {
    if (error.validationCode) return { valid: false, code: error.validationCode };
    if (controller.signal.aborted || error.name === 'AbortError') {
      return { valid: false, code: 'HLS_TIMEOUT' };
    }
    return { valid: false, code: 'HLS_CONNECTION_ERROR' };
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = { createHlsValidator, parseHttpUrl };
