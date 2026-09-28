'use strict';

const { normalizeEmbedCandidate, normalizeStreamCandidate } = require('../resolverContracts');
const { hasHlsExtension, sanitizePlaybackHeaders } = require('./directHlsResolver');

const PROBE_BYTES = 64;
const FALLBACK_STATUSES = new Set([403, 405, 501]);
const descriptor = Object.freeze({
  id: 'direct_mp4', active: true, priority: 900, strategy: 'direct',
  protocols: Object.freeze(['mp4']), domains: Object.freeze([]),
  aliases: Object.freeze([]), urlPatterns: Object.freeze([]), requiresBrowser: false,
});
const essence = (value) => String(value || '').split(';', 1)[0].trim().toLowerCase();
const mp4Type = (value) => ['video/mp4', 'application/octet-stream'].includes(essence(value));
const mp4Signature = (body) => Buffer.isBuffer(body) && body.length >= 12 &&
  body.toString('ascii', 4, 8) === 'ftyp';
const resolverError = (code) => Object.assign(new Error(code), { code });

const createDirectMp4Resolver = ({ httpClient, timeoutMs = 5_000, now = Date.now } = {}) => {
  if (!httpClient || typeof httpClient.head !== 'function' ||
      typeof httpClient.get !== 'function' || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30_000 || typeof now !== 'function') {
    throw resolverError('INVALID_MP4_RESOLVER_OPTIONS');
  }
  const canResolve = (candidate) => {
    const normalized = normalizeEmbedCandidate(candidate);
    return normalized !== null && !hasHlsExtension(normalized.url);
  };
  const resolve = async (candidate, context = {}) => {
    if (!canResolve(candidate)) return [];
    if (context.signal?.aborted) throw resolverError('HTTP_ABORTED');
    const normalized = normalizeEmbedCandidate(candidate);
    const startedAt = now();
    const deadlineAt = startedAt + timeoutMs;
    const remainingMs = () => {
      const remaining = deadlineAt - now();
      if (remaining < 1) throw resolverError('HTTP_TIMEOUT');
      return remaining;
    };
    let url = normalized.url;
    let headers = {
      ...normalized.headers,
      ...(normalized.referer && !normalized.headers.referer
        ? { referer: normalized.referer } : {}),
      ...(normalized.origin && !normalized.headers.origin
        ? { origin: normalized.origin } : {}),
    };
    const head = await httpClient.head(url, {
      headers, timeoutMs: remainingMs(), signal: context.signal,
    });
    if (!head.ok && !FALLBACK_STATUSES.has(head.status)) return [];
    const headType = head.ok ? head.headers['content-type'] : null;
    if (headType && !mp4Type(headType)) return [];
    headers = sanitizePlaybackHeaders(headers, url, head.url);
    url = head.url;
    const response = await httpClient.get(url, {
      headers: { ...headers, range: `bytes=0-${PROBE_BYTES - 1}` },
      timeoutMs: remainingMs(), maxBytes: PROBE_BYTES, signal: context.signal,
    });
    const getType = response.headers['content-type'];
    if (!response.ok || !mp4Signature(response.body) ||
        (getType && !mp4Type(getType)) || (!headType && !getType)) {
      return [];
    }
    const stream = normalizeStreamCandidate({
      url: response.url, protocol: 'mp4', providerId: normalized.providerId,
      resolverId: descriptor.id,
      headers: sanitizePlaybackHeaders(headers, url, response.url),
      quality: normalized.qualityHint, audioLanguage: normalized.languageHint,
      subtitleLanguage: null, expiresAt: normalized.expiresAt,
      urlSensitivity: normalized.urlSensitivity, validated: true,
      latencyMs: Math.max(0, now() - startedAt),
    });
    if (!stream) throw resolverError('INVALID_STREAM_CANDIDATE');
    return [stream];
  };
  return Object.freeze({ descriptor, canResolve, resolve });
};

module.exports = { createDirectMp4Resolver, mp4Signature, mp4Type, PROBE_BYTES };
