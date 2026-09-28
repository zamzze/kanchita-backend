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

const anchorBody = (html, lowerHtml, afterOpen) => {
  const close = lowerHtml.indexOf('</a', afterOpen);
  if (close < 0 || close - afterOpen > 512) return null;
  return html.slice(afterOpen, close);
};

const visibleAnchorText = (body) => body && decodeEntities(body.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();

const exactDescendantEpisodeMarker = (body) => {
  if (!body) return null;
  const safeBody = body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, '');
  let marker = null;
  for (const match of safeBody.matchAll(/<([a-z][a-z0-9:-]*)\b[^>]{0,256}>([^<]{1,32})<\/\1\s*>/gi)) {
    const text = decodeEntities(match[2]).trim();
    if (!/^\d{1,3}x\d{1,4}$/i.test(text)) continue;
    const [season, number] = text.toLowerCase().split('x').map(Number);
    if (season < 1 || number < 1 ||
        (marker && (marker.season !== season || marker.number !== number))) {
      return { invalid: true };
    }
    marker = { season, number };
  }
  return marker;
};

const plainLinkNumber = (text, kind) => {
  if (!text) return null;
  if (kind === 'season') {
    const matches = [...text.matchAll(/\btemporada\s+([1-9]\d{0,3})\b/gi)];
    if (!matches.length || matches.some((match) => match[1] !== matches[0][1])) return null;
    return { number: Number(matches[0][1]) };
  }
  const match = /\b([1-9]\d{0,3})\s*[x×]\s*([1-9]\d{0,3})\s*$/i.exec(text);
  return match ? { season: Number(match[1]), number: Number(match[2]) } : null;
};

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

  const extractLinks = (html, pageUrl, kind, limit, expectedSeason = null) => {
    const attribute = kind === 'season' ? 'data-season' : 'data-episode';
    const lowerHtml = html.toLowerCase();
    const found = [];
    const byPath = new Map();
    const byNumber = new Map();
    const conflicts = new Set();
    let inspected = 0;
    scanTags(html, (tag, raw, _start, afterOpen) => {
      if (tag !== 'a') return;
      const structured = parseAttribute(raw, attribute);
      const path = sameOriginPath(parseAttribute(raw,
        structured === null ? 'href' : 'data-href'), pageUrl);
      if (!path) return;
      let number;
      const body = anchorBody(html, lowerHtml, afterOpen);
      const exactMarker = kind === 'episode' ? exactDescendantEpisodeMarker(body) : null;
      if (exactMarker?.invalid) return;
      const marker = exactMarker || plainLinkNumber(visibleAnchorText(body), kind);
      if (structured !== null) {
        if (!validNumber(structured, 1)) return;
        number = Number(structured);
        if (marker && (marker.number !== number ||
            (kind === 'episode' && marker.season !== expectedSeason))) return;
      } else {
        const plainPathPattern = kind === 'season'
          ? /^\/temporada\/[^/]+\/?$/i : /^\/episodio\/[^/]+\/?$/i;
        if (!plainPathPattern.test(path)) return;
        if (!marker || (kind === 'episode' && marker.season !== expectedSeason)) return;
        number = marker.number;
      }
      inspected += 1;
      if (inspected > limit * 8) return;
      if (byPath.has(path)) {
        if (byPath.get(path) !== number) {
          conflicts.add(byPath.get(path));
          conflicts.add(number);
        }
        return;
      }
      byPath.set(path, number);
      if (byNumber.has(number) && byNumber.get(number) !== path) conflicts.add(number);
      else byNumber.set(number, path);
      found.push({ number, path });
    });
    if (found.length > limit || inspected > limit * 8) {
      throw new Error('HTML_EPISODE_DISCOVERY_LIMIT_EXCEEDED');
    }
    return found.filter(({ number }) => !conflicts.has(number));
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
      const episodes = extractLinks(page.html, page.url, 'episode',
        maxEpisodesPerSeason, season.number);
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
