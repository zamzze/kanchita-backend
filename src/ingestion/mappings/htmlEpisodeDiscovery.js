'use strict';

const { normalizeMedia, normalizeMappingResult } = require('./mappingContract');
const { decodeEntities, parseAttribute, scanTags } =
  require('../../modules/streams/resolverV2/html/staticHtmlExtractor');

const DEFAULT_MAX_SEASONS = 8;
const HARD_MAX_SEASONS = 16;
const DEFAULT_MAX_EPISODES = 32;
const HARD_MAX_EPISODES = 64;
const MAX_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 10_000;

const validNumber = (value, minimum) => typeof value === 'string' &&
  /^(?:0|[1-9]\d{0,3})$/.test(value) && Number(value) >= minimum;

const createHtmlEpisodeMappingDiscovery = ({
  providerId, region, baseUrl, seriesPathTemplate, http,
  maxSeasons = DEFAULT_MAX_SEASONS,
  maxEpisodesPerSeason = DEFAULT_MAX_EPISODES,
  timeoutMs = 5_000,
  now = () => new Date(),
} = {}) => {
  const descriptor = { id: providerId, region };
  let base;
  try { base = new URL(baseUrl); } catch { /* Invalid configuration. */ }
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(providerId || '') ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(region || '') ||
      !base || !['http:', 'https:'].includes(base.protocol) ||
      base.username || base.password || base.search || base.hash ||
      typeof seriesPathTemplate !== 'string' ||
      !/^\/[a-z0-9/_-]*\{externalId\}[a-z0-9/_-]*$/i.test(seriesPathTemplate) ||
      !http || typeof http.request !== 'function' ||
      !Number.isInteger(maxSeasons) || maxSeasons < 1 ||
      maxSeasons > HARD_MAX_SEASONS ||
      !Number.isInteger(maxEpisodesPerSeason) || maxEpisodesPerSeason < 1 ||
      maxEpisodesPerSeason > HARD_MAX_EPISODES ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 ||
      timeoutMs > MAX_TIMEOUT_MS || typeof now !== 'function') {
    throw new Error('HTML_EPISODE_DISCOVERY_INVALID_CONFIG');
  }

  const sameOriginPath = (raw, fromUrl) => {
    if (typeof raw !== 'string' || !raw || raw.length > 256) return null;
    try {
      const url = new URL(decodeEntities(raw), fromUrl);
      if (url.origin !== base.origin || url.username || url.password ||
          url.search || url.hash || !url.pathname.startsWith('/') ||
          url.pathname.length > 256 || /%2f|%5c/i.test(url.pathname)) return null;
      return url.pathname;
    } catch { return null; }
  };

  const extractLinks = (html, pageUrl, kind, limit) => {
    const attribute = kind === 'season' ? 'data-season' : 'data-episode';
    const found = new Map();
    const conflicts = new Set();
    let inspected = 0;
    scanTags(html, (tag, raw) => {
      if (tag !== 'a' || parseAttribute(raw, attribute) === null) return;
      inspected += 1;
      if (inspected > limit) return;
      const value = parseAttribute(raw, attribute);
      const path = sameOriginPath(parseAttribute(raw, 'data-href'), pageUrl);
      if (!validNumber(value, 1) || !path) return;
      const number = Number(value);
      if (found.has(number) && found.get(number) !== path) conflicts.add(number);
      else found.set(number, path);
    });
    if (inspected > limit) throw new Error('HTML_EPISODE_DISCOVERY_LIMIT_EXCEEDED');
    return [...found].filter(([number]) => !conflicts.has(number))
      .map(([number, path]) => ({ number, path }))
      .sort((a, b) => a.number - b.number);
  };

  const discover = async ({ series, externalId, signal } = {}) => {
    const normalizedSeries = normalizeMedia(series);
    if (!normalizedSeries || normalizedSeries.contentType !== 'series' ||
        typeof externalId !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(externalId)) {
      throw new Error('HTML_EPISODE_DISCOVERY_INVALID_INPUT');
    }
    const started = Date.now();
    const read = async (path) => {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining < 1) throw new Error('HTML_EPISODE_DISCOVERY_TIMEOUT');
      const url = new URL(path, base);
      const response = await http.request('GET', url.toString(), {
        timeoutMs: remaining, maxBytes: MAX_BYTES, maxRedirects: 0, signal,
      });
      if (!response.ok || !/^text\/html(?:\s*;|$)/i.test(
        response.headers?.['content-type'] || '') ||
          !Buffer.isBuffer(response.body) || response.body.length > MAX_BYTES) {
        throw new Error('HTML_EPISODE_DISCOVERY_INVALID_RESPONSE');
      }
      return { html: response.body.toString('utf8'), url: response.url };
    };
    const rootPath = seriesPathTemplate.replace('{externalId}', encodeURIComponent(externalId));
    const root = await read(rootPath);
    const seasons = extractLinks(root.html, root.url, 'season', maxSeasons);
    const mappings = [];
    const verifiedAt = now();
    for (const season of seasons) {
      const page = await read(season.path);
      const episodes = extractLinks(page.html, page.url, 'episode', maxEpisodesPerSeason);
      for (const episode of episodes) {
        const media = normalizeMedia({ contentType: 'episode',
          tmdbId: normalizedSeries.tmdbId, title: normalizedSeries.title,
          season: season.number, episode: episode.number });
        const mapping = normalizeMappingResult(descriptor, media, {
          providerId, region, externalId: episode.path,
          matchMethod: 'structured_episode_hierarchy', metadata: {},
        }, verifiedAt);
        if (mapping) mappings.push(mapping);
      }
    }
    return Object.freeze(mappings);
  };

  return Object.freeze({ discover });
};

module.exports = { createHtmlEpisodeMappingDiscovery,
  DEFAULT_MAX_SEASONS, HARD_MAX_SEASONS,
  DEFAULT_MAX_EPISODES, HARD_MAX_EPISODES };
