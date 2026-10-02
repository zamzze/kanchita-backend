'use strict';

const URL_SENSITIVITIES = Object.freeze(['normal', 'temporary_signed']);
const TEMPORARY_URL_SAFETY_WINDOW_MS = 60_000;
const MAX_JWT_LENGTH = 16_384;
const MAX_JWT_PAYLOAD_BYTES = 4_096;

const normalizeUrlSensitivity = (value) =>
  URL_SENSITIVITIES.includes(value) ? value : null;

const parseJwtExpiry = (token) => {
  if (typeof token !== 'string' || token.length < 3 || token.length > MAX_JWT_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
      parts[1].length > Math.ceil(MAX_JWT_PAYLOAD_BYTES * 4 / 3)) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url');
    if (payload.length === 0 || payload.length > MAX_JWT_PAYLOAD_BYTES) return null;
    const parsed = JSON.parse(payload.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Number.isInteger(parsed.exp) || parsed.exp <= 0 ||
        parsed.exp > Math.floor(8.64e15 / 1000)) return null;
    const expiresAt = new Date(parsed.exp * 1000);
    return Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null;
  } catch {
    return null;
  }
};

const temporaryExpiryFromUrl = (value, parameterNames = ['jwt']) => {
  if (!Array.isArray(parameterNames) || parameterNames.length === 0) return null;
  try {
    const url = new URL(value);
    for (const name of parameterNames) {
      if (typeof name !== 'string' || !name) continue;
      const expiry = parseJwtExpiry(url.searchParams.get(name));
      if (expiry) return expiry;
    }
    return null;
  } catch {
    return null;
  }
};

const isTemporaryUrlReusable = (stream, {
  now = Date.now(),
  safetyWindowMs = TEMPORARY_URL_SAFETY_WINDOW_MS,
} = {}) => {
  if (stream?.urlSensitivity !== 'temporary_signed' &&
      stream?.url_sensitivity !== 'temporary_signed') return true;
  const rawExpiry = stream.expiresAt ?? stream.expires_at;
  const expiry = rawExpiry ? new Date(rawExpiry).getTime() : Number.NaN;
  return Number.isFinite(expiry) && expiry - safetyWindowMs > now;
};

const describeUrlSafely = (value, { sensitive = false } = {}) => {
  try {
    const url = new URL(value);
    return Object.freeze({
      scheme: url.protocol.slice(0, -1),
      host: url.host,
      path: url.pathname,
      hasQuery: url.search.length > 0,
      sensitive: sensitive === true,
    });
  } catch {
    return Object.freeze({ scheme: null, host: null, path: null,
      hasQuery: false, sensitive: sensitive === true });
  }
};

module.exports = {
  MAX_JWT_LENGTH,
  MAX_JWT_PAYLOAD_BYTES,
  TEMPORARY_URL_SAFETY_WINDOW_MS,
  URL_SENSITIVITIES,
  describeUrlSafely,
  isTemporaryUrlReusable,
  normalizeUrlSensitivity,
  parseJwtExpiry,
  temporaryExpiryFromUrl,
};
