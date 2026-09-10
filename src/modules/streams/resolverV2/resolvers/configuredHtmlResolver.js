'use strict';

const { normalizeEmbedCandidate, normalizeStreamCandidate } = require('../resolverContracts');
const { extractLinks, normalizeSelectors } = require('../html/staticHtmlExtractor');
const { normalizePublicDomains, urlMatchesDomains } = require('../html/htmlConfig');
const { normalizeDomains, normalizePatterns } = require('./configuredHttpResolver');
const { hasHlsExtension } = require('./directHlsResolver');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'RESOLVER_HTML_INVALID_CONFIG',
  REQUEST_FAILED: 'RESOLVER_HTML_REQUEST_FAILED',
  HTTP_ERROR: 'RESOLVER_HTML_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'RESOLVER_HTML_INVALID_CONTENT_TYPE',
  CROSS_DOMAIN_REDIRECT: 'RESOLVER_HTML_CROSS_DOMAIN_REDIRECT',
});
const HEADER_POLICIES = Object.freeze(['none', 'referer', 'referer_origin']);
const DEFAULT_SELECTORS = Object.freeze(['source.src', 'video.src']);
const HTML_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
const MAX_BYTES = 512 * 1024;
const resolverError = (code) => Object.assign(new Error(code), { code });

const derivedHeaders = (policy, referer, origin) => {
  const headers = {};
  if ((policy === 'referer' || policy === 'referer_origin') && referer) headers.referer = referer;
  if (policy === 'referer_origin' && origin) headers.origin = origin;
  return headers;
};

const hostAllowed = (value, domains) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
};

const createConfiguredHtmlResolver = ({
  id = 'html_resolver', http, directHlsResolver, enabled = false, priority = 2_000,
  domains = [], aliases = [], pathPrefixes = [], timeoutMs = 2_000, maxStreams = 4,
  selectors = DEFAULT_SELECTORS, allowedMediaDomains = [], requestHeaderPolicy = 'referer',
  playbackHeaderPolicy = 'none', maxBytes = MAX_BYTES, maxRedirects = 3, now = Date.now,
} = {}) => {
  const normalizedDomains = normalizeDomains(domains);
  const normalizedAliases = normalizeDomains(aliases);
  const normalizedPatterns = normalizePatterns(pathPrefixes);
  const normalizedSelectors = normalizeSelectors(selectors);
  const mediaDomains = normalizePublicDomains(allowedMediaDomains);
  const routeDomains = [...(normalizedDomains || []), ...(normalizedAliases || [])];
  const validRoute = routeDomains.length > 0 || (normalizedPatterns?.length || 0) > 0;
  const configValid = normalizedDomains && normalizedAliases && normalizedPatterns &&
    normalizedSelectors && mediaDomains && validRoute &&
    HEADER_POLICIES.includes(requestHeaderPolicy) && HEADER_POLICIES.includes(playbackHeaderPolicy);
  const active = enabled === true && Boolean(configValid);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 8 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      typeof now !== 'function') throw resolverError(ERROR_CODES.INVALID_CONFIG);

  const descriptor = Object.freeze({ id, active, priority, strategy: 'http',
    protocols: Object.freeze(['hls']), domains: Object.freeze(normalizedDomains || []),
    aliases: Object.freeze(normalizedAliases || []),
    urlPatterns: Object.freeze(normalizedPatterns || []), requiresBrowser: false });
  const canResolve = (candidate) => active && normalizeEmbedCandidate(candidate) !== null &&
    !hasHlsExtension(candidate.url);

  const resolve = async (candidate, context = {}) => {
    const normalized = normalizeEmbedCandidate(candidate);
    if (!active || !normalized) return [];
    if (!http || typeof http.get !== 'function' || !directHlsResolver ||
        typeof directHlsResolver.resolve !== 'function') throw resolverError(ERROR_CODES.INVALID_CONFIG);
    const startedAt = now();
    const requestHeaders = { accept: 'text/html,application/xhtml+xml',
      ...derivedHeaders(requestHeaderPolicy, normalized.referer, normalized.origin) };
    let response;
    try {
      response = await http.get(normalized.url, {
        headers: requestHeaders, timeoutMs, maxBytes, maxRedirects, signal: context.signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw resolverError(ERROR_CODES.REQUEST_FAILED);
    }
    if (!response?.ok) throw resolverError(ERROR_CODES.HTTP_ERROR);
    if (typeof response.headers?.['content-type'] !== 'string' ||
        !HTML_CONTENT_TYPE.test(response.headers['content-type'].trim())) {
      throw resolverError(ERROR_CODES.INVALID_CONTENT_TYPE);
    }
    if (routeDomains.length > 0 && !hostAllowed(response.url, routeDomains)) {
      throw resolverError(ERROR_CODES.CROSS_DOMAIN_REDIRECT);
    }
    let finalPage;
    try { finalPage = new URL(response.url); } catch { throw resolverError(ERROR_CODES.REQUEST_FAILED); }
    const playbackHeaders = derivedHeaders(playbackHeaderPolicy,
      finalPage.toString(), finalPage.origin);
    const links = extractLinks(response.body.toString('utf8'), {
      baseUrl: finalPage.toString(), selectors: normalizedSelectors, maxLinks: maxStreams,
    });
    const streams = [];
    for (const link of links) {
      if (link.kind === 'iframe' || !urlMatchesDomains(link.url, mediaDomains)) continue;
      let checked;
      try {
        checked = await directHlsResolver.resolve({ providerId: normalized.providerId,
          url: link.url, headers: playbackHeaders, languageHint: normalized.languageHint,
          qualityHint: normalized.qualityHint }, context);
      } catch (error) {
        if (error?.code === 'HTTP_ABORTED' || error?.code === 'HTTP_TIMEOUT') throw error;
        continue;
      }
      for (const candidateStream of checked) {
        const stream = normalizeStreamCandidate({ ...candidateStream,
          providerId: normalized.providerId, resolverId: id, headers: playbackHeaders,
          latencyMs: Math.max(0, now() - startedAt),
          metadata: { resolverStrategy: 'http', discoveryType: link.kind,
            ...(Number.isInteger(normalized.metadata?.sourcePriority)
              ? { sourcePriority: normalized.metadata.sourcePriority } : {}) },
        });
        if (stream) streams.push(stream);
        if (streams.length >= maxStreams) return streams;
      }
    }
    return streams;
  };

  return Object.freeze({ descriptor, canResolve, resolve });
};

module.exports = {
  DEFAULT_SELECTORS, ERROR_CODES, HEADER_POLICIES, createConfiguredHtmlResolver, derivedHeaders,
};
