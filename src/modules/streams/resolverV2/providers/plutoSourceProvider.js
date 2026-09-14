'use strict';

const crypto = require('node:crypto');
const { normalizeEmbedCandidate } = require('../resolverContracts');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'SOURCE_PLUTO_INVALID_CONFIG',
  REQUEST_FAILED: 'SOURCE_PLUTO_REQUEST_FAILED',
  HTTP_ERROR: 'SOURCE_PLUTO_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'SOURCE_PLUTO_INVALID_CONTENT_TYPE',
  INVALID_JSON: 'SOURCE_PLUTO_INVALID_JSON',
  INVALID_RESPONSE: 'SOURCE_PLUTO_INVALID_RESPONSE',
});

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const PLUTO_ID = /^[A-Za-z0-9_-]{6,128}$/;
const MAX_MAPPINGS = 256;
const MAX_DISCOVERY_ITEMS = 20;
const DEFAULT_BOOT_URL = 'https://boot.pluto.tv/v4/start';
const DEFAULT_BASE_URL = 'https://api.pluto.tv';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_REFRESH_SKEW_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;

const providerError = (code) => Object.assign(new Error(code), { code });

const mediaKey = (entry) => entry.contentType === 'episode'
  ? `episode:${entry.tmdbId}:${entry.season}:${entry.episode}`
  : `movie:${entry.tmdbId}`;

const normalizeMediaMap = (value) => {
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) return null;
  const output = [];
  const keys = new Set();
  for (const entry of value) {
    const allowed = entry?.contentType === 'episode'
      ? ['contentType', 'tmdbId', 'season', 'episode', 'plutoId']
      : ['contentType', 'tmdbId', 'plutoId'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !allowed.includes(key)) ||
        !['movie', 'episode'].includes(entry.contentType) ||
        !Number.isInteger(entry.tmdbId) || entry.tmdbId < 1 ||
        typeof entry.plutoId !== 'string' || !PLUTO_ID.test(entry.plutoId) ||
        (entry.contentType === 'episode' && (!Number.isInteger(entry.season) ||
          entry.season < 0 || !Number.isInteger(entry.episode) || entry.episode < 1)) ||
        (entry.contentType === 'movie' &&
          (entry.season !== undefined || entry.episode !== undefined))) return null;
    const normalized = Object.freeze({
      contentType: entry.contentType,
      tmdbId: entry.tmdbId,
      ...(entry.contentType === 'episode'
        ? { season: entry.season, episode: entry.episode } : {}),
      plutoId: entry.plutoId,
    });
    const key = mediaKey(normalized);
    if (keys.has(key)) continue;
    keys.add(key);
    output.push(normalized);
  }
  return Object.freeze(output);
};

const parseJwtExpiry = (token, now) => {
  if (typeof token !== 'string') return 0;
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isInteger(decoded?.exp) ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
};

const normalizeHttpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
};

const firstHlsUrl = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stitched = value.stitched;
  const urls = Array.isArray(stitched?.urls) ? stitched.urls : [];
  for (const entry of urls) {
    const rawUrl = typeof entry?.url === 'string' ? entry.url : '';
    const url = normalizeHttpUrl(rawUrl);
    if (url && new URL(url).pathname.toLowerCase().endsWith('.m3u8')) return url;
  }
  return null;
};

const findPlutoItem = (payload, plutoId) => {
  const stack = Array.isArray(payload?.categories) ? [...payload.categories] : [payload];
  const seen = new Set();
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || Array.isArray(item) || seen.has(item)) continue;
    seen.add(item);
    if (item._id === plutoId || item.id === plutoId) return item;
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return null;
};

const contentKind = (item) => {
  const declared = [item?.type, item?.contentType, item?.kind]
    .find((value) => typeof value === 'string')?.toLowerCase() || '';
  if (declared.includes('episode') || Number.isInteger(item?.episodeNumber) ||
      Number.isInteger(item?.episode)) return 'episode';
  if (declared.includes('movie') || declared.includes('film')) return 'movie';
  return firstHlsUrl(item) ? 'movie' : 'unknown';
};

const discoverPlutoItem = (payload, limit = MAX_DISCOVERY_ITEMS) => {
  const boundedLimit = Number.isInteger(limit) && limit >= 1
    ? Math.min(limit, MAX_DISCOVERY_ITEMS) : MAX_DISCOVERY_ITEMS;
  const queue = Array.isArray(payload?.categories) ? [...payload.categories] : [payload];
  const seen = new Set();
  let itemsChecked = 0;
  for (let index = 0; index < queue.length && itemsChecked < boundedLimit; index += 1) {
    const item = queue[index];
    if (!item || typeof item !== 'object' || Array.isArray(item) || seen.has(item)) continue;
    seen.add(item);
    const plutoId = typeof item._id === 'string' ? item._id
      : typeof item.id === 'string' ? item.id : '';
    if (PLUTO_ID.test(plutoId)) {
      itemsChecked += 1;
      const url = firstHlsUrl(item);
      if (url) return Object.freeze({ plutoId, contentKind: contentKind(item), itemsChecked });
    }
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }
  return Object.freeze({ plutoId: null, contentKind: null, itemsChecked });
};

const safeJson = (response) => {
  const contentType = response?.headers?.['content-type'];
  if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
  }
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw providerError(ERROR_CODES.INVALID_JSON);
  }
};

const createBootUrl = ({ bootUrl, deviceId, sessionId }) => {
  const url = new URL(bootUrl);
  url.searchParams.set('appName', 'web');
  url.searchParams.set('appVersion', '1.0.0');
  url.searchParams.set('deviceType', 'web');
  url.searchParams.set('deviceMake', 'web');
  url.searchParams.set('deviceModel', 'web');
  url.searchParams.set('deviceVersion', 'unknown');
  url.searchParams.set('clientID', deviceId);
  url.searchParams.set('clientModelNumber', '1.0.0');
  url.searchParams.set('sid', sessionId);
  url.searchParams.set('deviceId', deviceId);
  return url.href;
};

const createPlutoSourceProvider = ({
  id = 'pluto_test',
  enabled = false,
  priority = 100,
  baseUrl = DEFAULT_BASE_URL,
  bootUrl = DEFAULT_BOOT_URL,
  http,
  timeoutMs = 3_000,
  maxCandidates = 2,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 3,
  mediaMap = [],
  supportsMovies = true,
  supportsEpisodes = true,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) => {
  const parsedBaseUrl = normalizeBaseUrl(baseUrl);
  const parsedBootUrl = normalizeHttpUrl(bootUrl);
  const mappings = normalizeMediaMap(mediaMap);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean' ||
      typeof now !== 'function' || typeof randomUUID !== 'function' ||
      mappings === null || !parsedBootUrl || (enabled && !parsedBaseUrl)) {
    throw providerError(ERROR_CODES.INVALID_CONFIG);
  }
  const active = enabled === true && parsedBaseUrl !== null;
  const mappingByKey = new Map(mappings.map((entry) => [mediaKey(entry), entry]));
  const state = { token: '', expiresAt: 0, deviceId: randomUUID(), sessionId: randomUUID() };

  const requestJson = async (client, url, { headers = {}, signal } = {}) => {
    let response;
    try {
      response = await client.get(url, {
        headers: { accept: 'application/json', ...headers },
        timeoutMs, maxBytes, maxRedirects, signal,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
      throw providerError(ERROR_CODES.REQUEST_FAILED);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw providerError(ERROR_CODES.HTTP_ERROR);
    return safeJson(response);
  };

  const boot = async (client, signal) => {
    if (state.token && state.expiresAt - SESSION_REFRESH_SKEW_MS > now()) {
      return state.token;
    }
    const payload = await requestJson(client, createBootUrl({
      bootUrl: parsedBootUrl, deviceId: state.deviceId, sessionId: state.sessionId,
    }), { signal });
    const token = typeof payload?.sessionToken === 'string' ? payload.sessionToken : '';
    if (!token) throw providerError(ERROR_CODES.INVALID_RESPONSE);
    const tokenExpiry = parseJwtExpiry(token, now);
    const fallbackExpiry = now() + DEFAULT_SESSION_TTL_MS;
    state.token = token;
    state.expiresAt = Math.min(
      tokenExpiry > now() ? tokenExpiry : fallbackExpiry,
      now() + MAX_SESSION_TTL_MS
    );
    return state.token;
  };

  const getCatalog = async (client, token, signal, { discovery = false } = {}) => {
    const basePath = parsedBaseUrl.pathname === '/' ? '' : parsedBaseUrl.pathname;
    const requestUrl = new URL(`${basePath}/v3/vod/categories`, parsedBaseUrl.origin);
    requestUrl.searchParams.set('includeItems', 'true');
    requestUrl.searchParams.set('deviceType', 'web');
    requestUrl.searchParams.set('offset', discovery ? '0' : '1000');
    if (discovery) requestUrl.searchParams.set('limit', String(MAX_DISCOVERY_ITEMS));
    return requestJson(client, requestUrl.href, {
      signal,
      headers: { authorization: `Bearer ${token}`, origin: 'https://pluto.tv',
        referer: 'https://pluto.tv/' },
    });
  };

  const clientFrom = (runtime) => {
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') {
      throw providerError(ERROR_CODES.INVALID_CONFIG);
    }
    return client;
  };

  const discoverPublicItem = async (runtime = {}) => {
    if (!active) return Object.freeze({ plutoId: null, contentKind: null, itemsChecked: 0 });
    const client = clientFrom(runtime);
    const token = await boot(client, runtime.signal);
    if (typeof runtime.onStage === 'function') runtime.onStage('boot');
    const payload = await getCatalog(client, token, runtime.signal, { discovery: true });
    if (typeof runtime.onStage === 'function') runtime.onStage('catalog');
    if (payload === null) {
      return Object.freeze({ plutoId: null, contentKind: null, itemsChecked: 0 });
    }
    return discoverPlutoItem(payload, runtime.maxItems);
  };

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const mapping = mappingByKey.get(mediaKey(mediaContext));
    if (!mapping) return [];
    const client = clientFrom(runtime);
    const token = await boot(client, runtime.signal);
    const payload = await getCatalog(client, token, runtime.signal);
    if (payload === null) return [];
    const item = findPlutoItem(payload, mapping.plutoId);
    if (!item) return [];
    const url = firstHlsUrl(item);
    if (!url) return [];
    const candidate = normalizeEmbedCandidate({
      providerId: id,
      url,
      headers: {},
      qualityHint: 'auto',
      metadata: { sourceType: 'pluto' },
    });
    return candidate ? [candidate].slice(0, maxCandidates) : [];
  };

  return Object.freeze({
    descriptor: Object.freeze({
      id,
      active,
      priority,
      supportsMovies,
      supportsEpisodes,
      languages: Object.freeze([]),
      strategy: 'http',
      timeoutMs,
      maxCandidates,
    }),
    discoverPublicItem,
    getSources,
  });
};

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_BOOT_URL,
  ERROR_CODES,
  MAX_DISCOVERY_ITEMS,
  MAX_MAPPINGS,
  createPlutoSourceProvider,
  discoverPlutoItem,
  findPlutoItem,
  firstHlsUrl,
  normalizeMediaMap,
};
