'use strict';

const { normalizeEmbedCandidate } = require('../resolverContracts');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'SOURCE_HTTP_INVALID_CONFIG',
  REQUEST_FAILED: 'SOURCE_HTTP_REQUEST_FAILED',
  HTTP_ERROR: 'SOURCE_HTTP_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'SOURCE_HTTP_INVALID_CONTENT_TYPE',
  INVALID_JSON: 'SOURCE_HTTP_INVALID_JSON',
  INVALID_RESPONSE: 'SOURCE_HTTP_INVALID_RESPONSE',
});
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const DEFAULT_MAX_BYTES = 256 * 1024;

const providerError = (code) => Object.assign(new Error(code), { code });

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
};

const createConfiguredHttpSourceProvider = ({
  id = 'provider_a',
  baseUrl = '',
  http,
  enabled = false,
  priority = 100,
  timeoutMs = 2_000,
  maxCandidates = 8,
  headers = {},
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 3,
} = {}) => {
  const parsedBaseUrl = normalizeBaseUrl(baseUrl);
  const active = enabled === true && parsedBaseUrl !== null;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      !headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw providerError(ERROR_CODES.INVALID_CONFIG);
  }
  const configuredHeaders = Object.freeze({ accept: 'application/json', ...headers });

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') {
      throw providerError(ERROR_CODES.INVALID_CONFIG);
    }
    const path = mediaContext.contentType === 'movie'
      ? `/sources/movie/${encodeURIComponent(mediaContext.tmdbId)}`
      : `/sources/episode/${encodeURIComponent(mediaContext.tmdbId)}`;
    const basePath = parsedBaseUrl.pathname === '/' ? '' : parsedBaseUrl.pathname;
    const requestUrl = new URL(`${basePath}${path}`, parsedBaseUrl.origin);
    if (mediaContext.contentType === 'episode') {
      requestUrl.searchParams.set('season', String(mediaContext.season));
      requestUrl.searchParams.set('episode', String(mediaContext.episode));
    }

    let response;
    try {
      response = await client.get(requestUrl.toString(), {
        headers: configuredHeaders,
        timeoutMs,
        maxBytes,
        maxRedirects,
        signal: runtime.signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw providerError(ERROR_CODES.REQUEST_FAILED);
    }
    if (!response?.ok) throw providerError(ERROR_CODES.HTTP_ERROR);
    const contentType = response.headers?.['content-type'];
    if (contentType !== undefined && (typeof contentType !== 'string' ||
        !JSON_CONTENT_TYPE.test(contentType.trim()))) {
      throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
    }

    let payload;
    try {
      payload = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw providerError(ERROR_CODES.INVALID_JSON);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Array.isArray(payload.sources)) {
      throw providerError(ERROR_CODES.INVALID_RESPONSE);
    }

    const candidates = [];
    for (const source of payload.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const candidate = normalizeEmbedCandidate({
        providerId: id,
        url: source.url,
        referer: source.referer,
        origin: source.origin,
        headers: source.headers,
        languageHint: source.language,
        qualityHint: source.quality,
        metadata: source.metadata,
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) break;
    }
    if (payload.sources.length > 0 && candidates.length === 0) {
      throw providerError(ERROR_CODES.INVALID_RESPONSE);
    }
    return candidates;
  };

  return Object.freeze({
    descriptor: Object.freeze({
      id,
      active,
      priority,
      supportsMovies: true,
      supportsEpisodes: true,
      languages: Object.freeze([]),
      strategy: 'http',
      timeoutMs,
      maxCandidates,
    }),
    getSources,
  });
};

module.exports = {
  ERROR_CODES,
  createConfiguredHttpSourceProvider,
  normalizeBaseUrl,
};
