'use strict';

const https = require('node:https');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const tmdbError = (code, status = null, retryAfterMs = null) =>
  Object.assign(new Error(code), { code, status, retryAfterMs });

const retryAfterMs = (header) => {
  if (typeof header !== 'string') return null;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 10_000) : null;
};

const get = (path, params = {}) => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || apiKey === 'your_tmdb_api_key') {
    return Promise.reject(tmdbError('TMDB_KEY_MISSING'));
  }
  const query = new URLSearchParams({ api_key: apiKey, language: 'es-ES', ...params });
  const url = `${TMDB_BASE}${path}?${query}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(tmdbError('TMDB_RESPONSE_TOO_LARGE', response.statusCode));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(tmdbError('TMDB_HTTP_ERROR', response.statusCode,
            retryAfterMs(response.headers['retry-after'])));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || parsed.status_code) {
            fail(tmdbError('TMDB_INVALID_RESPONSE', response.statusCode));
          } else {
            settled = true;
            resolve(parsed);
          }
        } catch { fail(tmdbError('TMDB_INVALID_RESPONSE', response.statusCode)); }
      });
      response.on('error', () => fail(tmdbError('TMDB_REQUEST_FAILED')));
    });
    request.on('timeout', () => {
      fail(tmdbError('TMDB_TIMEOUT'));
      request.destroy();
    });
    request.on('error', () => fail(tmdbError('TMDB_REQUEST_FAILED')));
  });
};

module.exports = { get };
