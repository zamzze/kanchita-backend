'use strict';

const { normalizeEmbedCandidate, normalizeStreamCandidate } = require('../resolverContracts');
const { hasHlsExtension } = require('./directHlsResolver');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'RESOLVER_HTTP_INVALID_CONFIG',
  REQUEST_FAILED: 'RESOLVER_HTTP_REQUEST_FAILED',
  HTTP_ERROR: 'RESOLVER_HTTP_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'RESOLVER_HTTP_INVALID_CONTENT_TYPE',
  INVALID_JSON: 'RESOLVER_HTTP_INVALID_JSON',
  INVALID_RESPONSE: 'RESOLVER_HTTP_INVALID_RESPONSE',
});
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const DOMAIN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const resolverError = (code) => Object.assign(new Error(code), { code });

const normalizeDomains = (value) => {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const output = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const domain = item.trim().toLowerCase();
    if (!domain || !DOMAIN.test(domain) || /[:/?#@]/.test(domain)) return null;
    if (!seen.has(domain)) {
      seen.add(domain);
      output.push(domain);
    }
  }
  return output;
};

const normalizePatterns = (value) => {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const output = [];
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const pattern = item.trim();
    if (!pattern.startsWith('/') || pattern.length > 512 || /[?#]/.test(pattern)) return null;
    if (!output.includes(pattern)) output.push(pattern);
  }
  return output;
};

const createConfiguredHttpResolver = ({
  id = 'resolver_a',
  http,
  hlsResolver,
  enabled = false,
  domains = [],
  aliases = [],
  urlPatterns = [],
  priority = 2000,
  timeoutMs = 2_000,
  maxStreams = 4,
  headers = {},
  maxBytes = 256 * 1024,
  maxRedirects = 3,
  now = Date.now,
} = {}) => {
  const normalizedDomains = normalizeDomains(domains);
  const normalizedAliases = normalizeDomains(aliases);
  const normalizedPatterns = normalizePatterns(urlPatterns);
  const validConfig = normalizedDomains !== null && normalizedAliases !== null &&
    normalizedPatterns !== null && (normalizedDomains.length > 0 ||
      normalizedAliases.length > 0 || normalizedPatterns.length > 0);
  const active = enabled === true && validConfig;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 16 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      !headers || typeof headers !== 'object' || Array.isArray(headers) ||
      typeof now !== 'function') {
    throw resolverError(ERROR_CODES.INVALID_CONFIG);
  }
  const configuredHeaders = Object.freeze({ accept: 'application/json', ...headers });
  const client = http;
  const descriptor = Object.freeze({
    id, active, priority, strategy: 'http', protocols: Object.freeze(['hls']),
    domains: Object.freeze(normalizedDomains || []),
    aliases: Object.freeze(normalizedAliases || []),
    urlPatterns: Object.freeze(normalizedPatterns || []),
    requiresBrowser: false,
  });

  const canResolve = (candidate) => active && normalizeEmbedCandidate(candidate) !== null &&
    !hasHlsExtension(candidate.url);

  const resolve = async (candidate, context = {}) => {
    const normalized = normalizeEmbedCandidate(candidate);
    if (!active || !normalized) return [];
    if (!client || typeof client.get !== 'function' ||
        !hlsResolver || typeof hlsResolver.resolve !== 'function') {
      throw resolverError(ERROR_CODES.INVALID_CONFIG);
    }
    const startedAt = now();
    const resolverRequestHeaders = {
      ...normalized.headers,
      ...(normalized.referer && !normalized.headers.referer
        ? { referer: normalized.referer } : {}),
      ...(normalized.origin && !normalized.headers.origin
        ? { origin: normalized.origin } : {}),
      ...configuredHeaders,
    };
    let response;
    try {
      response = await client.get(normalized.url, {
        headers: resolverRequestHeaders, timeoutMs, maxBytes, maxRedirects,
        signal: context.signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw resolverError(ERROR_CODES.REQUEST_FAILED);
    }
    if (!response?.ok) throw resolverError(ERROR_CODES.HTTP_ERROR);
    const contentType = response.headers?.['content-type'];
    if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
      throw resolverError(ERROR_CODES.INVALID_CONTENT_TYPE);
    }

    let payload;
    try {
      payload = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw resolverError(ERROR_CODES.INVALID_JSON);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Array.isArray(payload.streams)) {
      throw resolverError(ERROR_CODES.INVALID_RESPONSE);
    }

    const streams = [];
    for (const raw of payload.streams) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== 'hls') continue;
      const proposed = normalizeStreamCandidate({
        url: raw.url,
        protocol: 'hls',
        providerId: normalized.providerId,
        resolverId: id,
        headers: raw.headers,
        quality: raw.quality,
        audioLanguage: raw.audioLanguage,
        subtitleLanguage: raw.subtitleLanguage,
        expiresAt: raw.expiresAt,
        metadata: raw.metadata,
        validated: false,
      });
      if (!proposed) continue;
      const validated = await hlsResolver.resolve({
        providerId: normalized.providerId,
        url: proposed.url,
        headers: proposed.headers,
        qualityHint: proposed.quality,
        languageHint: proposed.audioLanguage,
        metadata: proposed.metadata,
      }, context);
      for (const checked of validated) {
        const stream = normalizeStreamCandidate({
          ...checked,
          providerId: normalized.providerId,
          resolverId: id,
          quality: proposed.quality,
          audioLanguage: proposed.audioLanguage,
          subtitleLanguage: proposed.subtitleLanguage,
          expiresAt: proposed.expiresAt,
          metadata: proposed.metadata,
          latencyMs: Math.max(0, now() - startedAt),
        });
        if (stream) streams.push(stream);
        if (streams.length >= maxStreams) break;
      }
      if (streams.length >= maxStreams) break;
    }
    return streams;
  };

  return Object.freeze({ descriptor, canResolve, resolve });
};

module.exports = {
  ERROR_CODES,
  createConfiguredHttpResolver,
  normalizeDomains,
  normalizePatterns,
};
