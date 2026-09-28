'use strict';

const {
  normalizeEmbedCandidate,
  normalizeStreamCandidate,
} = require('../resolverContracts');
const { inspectHlsManifest } = require('../hlsInspector');

const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
]);
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const HEAD_GET_FALLBACK_STATUSES = new Set([403, 405, 501]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie',
]);

const descriptor = Object.freeze({
  id: 'direct_hls',
  active: true,
  priority: 1000,
  strategy: 'direct',
  protocols: Object.freeze(['hls']),
  domains: Object.freeze([]),
  aliases: Object.freeze([]),
  urlPatterns: Object.freeze([]),
  requiresBrowser: false,
});

const contentTypeEssence = (value) => String(value || '').split(';', 1)[0].trim().toLowerCase();
const isHlsContentType = (value) => HLS_CONTENT_TYPES.has(contentTypeEssence(value));
const isHtmlContentType = (value) => HTML_CONTENT_TYPES.has(contentTypeEssence(value));

const hasHlsExtension = (value) => {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
};

const originsDiffer = (initialUrl, finalUrl) => {
  try {
    return new URL(initialUrl).origin !== new URL(finalUrl).origin;
  } catch {
    return true;
  }
};

const sanitizePlaybackHeaders = (headers, initialUrl, finalUrl) => {
  if (!originsDiffer(initialUrl, finalUrl)) return { ...headers };
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !CROSS_ORIGIN_SENSITIVE_HEADERS.has(name.toLowerCase())));
};

const resolverError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const createDirectHlsResolver = ({
  httpClient,
  timeoutMs = 5000,
  maxManifestBytes = 256 * 1024,
  now = Date.now,
} = {}) => {
  if (!httpClient || typeof httpClient.get !== 'function' ||
      typeof httpClient.head !== 'function') throw resolverError('INVALID_HTTP_CLIENT');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isInteger(maxManifestBytes) || maxManifestBytes <= 0) {
    throw resolverError('INVALID_RESOLVER_OPTIONS');
  }

  const canResolve = (candidate) => {
    const normalized = normalizeEmbedCandidate(candidate);
    return normalized !== null && !new URL(normalized.url).pathname.toLowerCase().endsWith('.mp4');
  };

  const resolve = async (candidate, context = {}) => {
    const normalized = normalizeEmbedCandidate(candidate);
    if (!normalized || !canResolve(normalized)) return [];
    if (context.signal?.aborted) throw resolverError('HTTP_ABORTED');

    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    const initialUrl = normalized.url;
    let requestUrl = initialUrl;
    let requestHeaders = {
      ...normalized.headers,
      ...(normalized.referer && !normalized.headers.referer
        ? { referer: normalized.referer } : {}),
      ...(normalized.origin && !normalized.headers.origin
        ? { origin: normalized.origin } : {}),
    };

    const remainingMs = () => {
      const remaining = deadline - now();
      if (remaining < 1) throw resolverError('HTTP_TIMEOUT');
      return remaining;
    };

    if (!hasHlsExtension(requestUrl)) {
      const head = await httpClient.head(requestUrl, {
        headers: requestHeaders,
        timeoutMs: remainingMs(),
        signal: context.signal,
      });
      if (!head.ok && !HEAD_GET_FALLBACK_STATUSES.has(head.status)) return [];
      if (head.ok && (isHtmlContentType(head.headers['content-type']) ||
          String(head.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() ===
            'video/mp4')) return [];
      requestHeaders = sanitizePlaybackHeaders(requestHeaders, requestUrl, head.url);
      requestUrl = head.url;
    }

    const response = await httpClient.get(requestUrl, {
      headers: requestHeaders,
      timeoutMs: remainingMs(),
      maxBytes: maxManifestBytes,
      signal: context.signal,
    });
    if (!response.ok) return [];

    const hlsInfo = inspectHlsManifest(response.body.toString('utf8'), {
      baseUrl: response.url,
    });
    if (!hlsInfo.isHls) return [];

    const stream = normalizeStreamCandidate({
      url: response.url,
      protocol: 'hls',
      providerId: normalized.providerId,
      resolverId: descriptor.id,
      headers: sanitizePlaybackHeaders(requestHeaders, requestUrl, response.url),
      quality: normalized.qualityHint,
      audioLanguage: normalized.languageHint,
      subtitleLanguage: null,
      expiresAt: normalized.expiresAt,
      urlSensitivity: normalized.urlSensitivity,
      validated: true,
      latencyMs: Math.max(0, now() - startedAt),
      hlsInfo,
    });
    if (!stream) throw resolverError('INVALID_STREAM_CANDIDATE');
    return [stream];
  };

  return Object.freeze({ descriptor, canResolve, resolve });
};

module.exports = {
  createDirectHlsResolver,
  hasHlsExtension,
  isHlsContentType,
  isHtmlContentType,
  sanitizePlaybackHeaders,
};
