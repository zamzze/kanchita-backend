'use strict';

const { normalizeEmbedCandidate } = require('../resolverContracts');
const { extractLinks, normalizeSelectors } = require('../html/staticHtmlExtractor');
const { normalizeMediaPathTemplate, renderMediaPath } = require('../html/mediaPathTemplate');
const { normalizePublicDomains, urlMatchesDomains } = require('../html/htmlConfig');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'SOURCE_HTML_INVALID_CONFIG',
  REQUEST_FAILED: 'SOURCE_HTML_REQUEST_FAILED',
  HTTP_ERROR: 'SOURCE_HTML_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'SOURCE_HTML_INVALID_CONTENT_TYPE',
  CROSS_ORIGIN_REDIRECT: 'SOURCE_HTML_CROSS_ORIGIN_REDIRECT',
});
const HTML_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
const DEFAULT_SELECTORS = Object.freeze(['iframe.src', 'source.src', 'video.src']);
const MAX_BYTES = 512 * 1024;
const providerError = (code) => Object.assign(new Error(code), { code });

const createConfiguredHtmlSourceProvider = ({
  id = 'html_source', baseUrl = '', http, enabled = false, priority = 100,
  timeoutMs = 2_000, maxCandidates = 16, supportsMovies = true, supportsEpisodes = true,
  moviePathTemplate = '/movie/{tmdbId}',
  episodePathTemplate = '/series/{tmdbId}/{season}/{episode}',
  selectors = DEFAULT_SELECTORS, allowedCandidateDomains = [], authToken = null,
  maxBytes = MAX_BYTES, maxRedirects = 3,
} = {}) => {
  const base = normalizeBaseUrl(baseUrl);
  const normalizedSelectors = normalizeSelectors(selectors);
  const domains = normalizePublicDomains(allowedCandidateDomains);
  const movieTemplate = normalizeMediaPathTemplate(moviePathTemplate);
  const episodeTemplate = normalizeMediaPathTemplate(episodePathTemplate);
  const configValid = base && normalizedSelectors && domains &&
    (!supportsMovies || movieTemplate) && (!supportsEpisodes || episodeTemplate);
  const active = enabled === true && Boolean(configValid);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32 ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean' ||
      (authToken !== null && (typeof authToken !== 'string' || !authToken.trim())) ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw providerError(ERROR_CODES.INVALID_CONFIG);
  }

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') throw providerError(ERROR_CODES.INVALID_CONFIG);
    const template = mediaContext.contentType === 'movie' ? movieTemplate : episodeTemplate;
    const requestUrl = renderMediaPath(template, mediaContext, base.toString());
    if (!requestUrl) throw providerError(ERROR_CODES.INVALID_CONFIG);
    let response;
    try {
      response = await client.get(requestUrl, {
        headers: { accept: 'text/html,application/xhtml+xml',
          ...(authToken ? { authorization: `Bearer ${authToken.trim()}` } : {}) },
        timeoutMs, maxBytes, maxRedirects, signal: runtime.signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw providerError(ERROR_CODES.REQUEST_FAILED);
    }
    if (!response?.ok) throw providerError(ERROR_CODES.HTTP_ERROR);
    if (typeof response.headers?.['content-type'] !== 'string' ||
        !HTML_CONTENT_TYPE.test(response.headers['content-type'].trim())) {
      throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
    }
    let finalUrl;
    try { finalUrl = new URL(response.url); } catch { throw providerError(ERROR_CODES.REQUEST_FAILED); }
    if (finalUrl.origin !== base.origin) throw providerError(ERROR_CODES.CROSS_ORIGIN_REDIRECT);

    const links = extractLinks(response.body.toString('utf8'), {
      baseUrl: finalUrl.toString(), selectors: normalizedSelectors, maxLinks: maxCandidates,
    });
    const candidates = [];
    for (const link of links) {
      if (!urlMatchesDomains(link.url, domains)) continue;
      const candidate = normalizeEmbedCandidate({
        providerId: id, url: link.url, referer: finalUrl.toString(), origin: finalUrl.origin,
        headers: {}, languageHint: null, qualityHint: null,
        metadata: { discoveryType: link.kind, sourceType: 'configured_html' },
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  };

  return Object.freeze({
    descriptor: Object.freeze({ id, active, priority, supportsMovies, supportsEpisodes,
      languages: Object.freeze([]), strategy: 'http', timeoutMs, maxCandidates }),
    getSources,
  });
};

module.exports = { DEFAULT_SELECTORS, ERROR_CODES, createConfiguredHtmlSourceProvider };
