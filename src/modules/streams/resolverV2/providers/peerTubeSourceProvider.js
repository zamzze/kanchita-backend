'use strict';

const { normalizeEmbedCandidate } = require('../resolverContracts');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'SOURCE_PEERTUBE_INVALID_CONFIG',
  REQUEST_FAILED: 'SOURCE_PEERTUBE_REQUEST_FAILED',
  HTTP_ERROR: 'SOURCE_PEERTUBE_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'SOURCE_PEERTUBE_INVALID_CONTENT_TYPE',
  INVALID_JSON: 'SOURCE_PEERTUBE_INVALID_JSON',
  INVALID_RESPONSE: 'SOURCE_PEERTUBE_INVALID_RESPONSE',
});
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const VIDEO_ID = /^(?:[1-9]\d{0,15}|[A-Za-z0-9_-]{6,128})$/;
const MAX_MAPPINGS = 256;
const DEFAULT_MAX_BYTES = 512 * 1024;
const providerError = (code) => Object.assign(new Error(code), { code });

const mediaKey = (entry) => entry.contentType === 'episode'
  ? `episode:${entry.tmdbId}:${entry.season}:${entry.episode}`
  : `movie:${entry.tmdbId}`;

const normalizeMediaMap = (value) => {
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) return null;
  const output = [];
  const keys = new Set();
  for (const entry of value) {
    const videoId = Number.isInteger(entry?.videoId) && entry.videoId > 0
      ? String(entry.videoId) : entry?.videoId;
    const allowed = entry?.contentType === 'episode'
      ? ['contentType', 'tmdbId', 'season', 'episode', 'videoId']
      : ['contentType', 'tmdbId', 'videoId'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !allowed.includes(key)) ||
        !['movie', 'episode'].includes(entry.contentType) ||
        !Number.isInteger(entry.tmdbId) || entry.tmdbId < 1 ||
        typeof videoId !== 'string' || !VIDEO_ID.test(videoId) ||
        (entry.contentType === 'episode' && (!Number.isInteger(entry.season) ||
          entry.season < 0 || !Number.isInteger(entry.episode) || entry.episode < 1)) ||
        (entry.contentType === 'movie' &&
          (entry.season !== undefined || entry.episode !== undefined))) return null;
    const normalized = Object.freeze({
      contentType: entry.contentType,
      tmdbId: entry.tmdbId,
      ...(entry.contentType === 'episode'
        ? { season: entry.season, episode: entry.episode } : {}),
      videoId,
    });
    const key = mediaKey(normalized);
    if (keys.has(key)) continue;
    keys.add(key);
    output.push(normalized);
  }
  return Object.freeze(output);
};

const extractPlaylistUrls = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Array.isArray(payload.streamingPlaylists)) return null;
  const urls = [];
  const seen = new Set();
  for (const playlist of payload.streamingPlaylists) {
    if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist) ||
        typeof playlist.playlistUrl !== 'string') continue;
    try {
      const parsed = new URL(playlist.playlistUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username ||
          parsed.password || seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      urls.push(parsed.href);
    } catch { /* invalid remote playlist */ }
  }
  return urls;
};

const createPeerTubeSourceProvider = ({
  id = 'peertube',
  baseUrl = '',
  http,
  enabled = false,
  priority = 100,
  timeoutMs = 3_000,
  maxCandidates = 2,
  mediaMap = [],
  supportsMovies = true,
  supportsEpisodes = true,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 3,
} = {}) => {
  const parsedBaseUrl = normalizeBaseUrl(baseUrl);
  const mappings = normalizeMediaMap(mediaMap);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32 ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean' ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxRedirects) ||
      maxRedirects < 0 || maxRedirects > 10 || mappings === null ||
      (enabled && !parsedBaseUrl)) throw providerError(ERROR_CODES.INVALID_CONFIG);
  const active = enabled === true && parsedBaseUrl !== null;
  const mappingByKey = new Map(mappings.map((entry) => [mediaKey(entry), entry.videoId]));

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const key = mediaKey(mediaContext);
    const videoId = mappingByKey.get(key);
    if (!videoId) return [];
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') {
      throw providerError(ERROR_CODES.INVALID_CONFIG);
    }
    const basePath = parsedBaseUrl.pathname === '/' ? '' : parsedBaseUrl.pathname;
    const requestUrl = new URL(`${basePath}/api/v1/videos/${encodeURIComponent(videoId)}`,
      parsedBaseUrl.origin);
    let response;
    try {
      response = await client.get(requestUrl.href, {
        headers: { accept: 'application/json' }, timeoutMs, maxBytes, maxRedirects,
        signal: runtime.signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw providerError(ERROR_CODES.REQUEST_FAILED);
    }
    if (response?.status === 404) return [];
    if (!response?.ok) throw providerError(ERROR_CODES.HTTP_ERROR);
    const contentType = response.headers?.['content-type'];
    if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
      throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
    }
    let payload;
    try { payload = JSON.parse(response.body.toString('utf8')); } catch {
      throw providerError(ERROR_CODES.INVALID_JSON);
    }
    const urls = extractPlaylistUrls(payload);
    if (urls === null) throw providerError(ERROR_CODES.INVALID_RESPONSE);
    const candidates = [];
    for (const url of urls) {
      const candidate = normalizeEmbedCandidate({
        providerId: id, url, headers: {}, qualityHint: 'auto',
        metadata: { sourceType: 'peertube' },
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) break;
    }
    return candidates;
  };

  return Object.freeze({
    descriptor: Object.freeze({ id, active, priority, supportsMovies, supportsEpisodes,
      languages: Object.freeze([]), strategy: 'http', timeoutMs, maxCandidates }),
    getSources,
  });
};

module.exports = {
  ERROR_CODES,
  MAX_MAPPINGS,
  createPeerTubeSourceProvider,
  extractPlaylistUrls,
  normalizeMediaMap,
};
