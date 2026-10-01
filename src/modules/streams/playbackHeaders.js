'use strict';

const PLAYBACK_HEADER_CODES = Object.freeze({
  INVALID: 'PRIMARY_HEADERS_INVALID',
  UNSUPPORTED: 'PRIMARY_HEADERS_UNSUPPORTED',
});
const ALLOWED_HEADERS = new Set(['referer', 'origin']);
const MAX_HEADER_VALUE_LENGTH = 2_048;

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizePlaybackHeaders = (input) => {
  if (input === undefined || input === null) return { ok: true, headers: {} };
  if (!isPlainObject(input)) return { ok: false, code: PLAYBACK_HEADER_CODES.INVALID };
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
    if (!ALLOWED_HEADERS.has(name)) {
      return { ok: false, code: PLAYBACK_HEADER_CODES.UNSUPPORTED };
    }
    if (typeof rawValue !== 'string' || !rawValue || /[\r\n]/.test(rawValue) ||
        rawValue.length > MAX_HEADER_VALUE_LENGTH) {
      return { ok: false, code: PLAYBACK_HEADER_CODES.INVALID };
    }
    let parsed;
    try { parsed = new URL(rawValue); } catch {
      return { ok: false, code: PLAYBACK_HEADER_CODES.INVALID };
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { ok: false, code: PLAYBACK_HEADER_CODES.INVALID };
    }
    if (name === 'origin' && rawValue !== parsed.origin) {
      return { ok: false, code: PLAYBACK_HEADER_CODES.INVALID };
    }
    headers[name] = rawValue;
  }
  return { ok: true, headers: Object.freeze(headers) };
};

const playbackHeadersOrNull = (input) => {
  const result = normalizePlaybackHeaders(input);
  return result.ok ? result.headers : null;
};

const isPlaybackTransportConfigured = ({ enabled, secret, publicBaseUrl = '' } = {}) => {
  if (enabled !== true || typeof secret !== 'string' || secret.length < 32 ||
      typeof publicBaseUrl !== 'string') return false;
  if (!publicBaseUrl) return true;
  try {
    const parsed = new URL(publicBaseUrl);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
};

module.exports = {
  ALLOWED_HEADERS,
  MAX_HEADER_VALUE_LENGTH,
  PLAYBACK_HEADER_CODES,
  normalizePlaybackHeaders,
  playbackHeadersOrNull,
  isPlaybackTransportConfigured,
};
