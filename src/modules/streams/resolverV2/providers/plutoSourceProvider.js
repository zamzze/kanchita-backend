'use strict';

const crypto = require('node:crypto');
const { normalizeEmbedCandidate } = require('../resolverContracts');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');
const { parseJwtExpiry, temporaryExpiryFromUrl } = require('../../temporaryStreamUrl');

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
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_MAPPINGS = 256;
const MAX_DISCOVERY_ITEMS = 20;
const DEFAULT_BOOT_URL = 'https://boot.pluto.tv/v4/start';
const DEFAULT_BASE_URL = 'https://service-vod.clusters.pluto.tv';
const DEFAULT_EPISODE_BASE_URL = 'https://api.pluto.tv';
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

const normalizeHlsPath = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  try {
    const url = new URL(value.trim(), 'https://example.test');
    return url.pathname.toLowerCase().endsWith('.m3u8') ? value.trim() : null;
  } catch {
    return null;
  }
};

const stitchedHlsPath = (item) => {
  const stitched = item?.stitched;
  const direct = normalizeHlsPath(stitched?.path);
  if (direct) return direct;
  const paths = Array.isArray(stitched?.paths) ? stitched.paths : [];
  for (const entry of paths) {
    const path = normalizeHlsPath(typeof entry === 'string' ? entry : entry?.path);
    const type = typeof entry?.type === 'string' ? entry.type.toLowerCase() : 'hls';
    if (path && type === 'hls') return path;
  }
  return null;
};

const discoverBootItem = (payload, limit = MAX_DISCOVERY_ITEMS) => {
  const boundedLimit = Number.isInteger(limit) && limit >= 1
    ? Math.min(limit, MAX_DISCOVERY_ITEMS) : MAX_DISCOVERY_ITEMS;
  const items = [...(Array.isArray(payload?.EPG) ? payload.EPG : []),
    ...(Array.isArray(payload?.VOD) ? payload.VOD : [])];
  let itemsChecked = 0;
  for (const item of items.slice(0, boundedLimit)) {
    const plutoId = typeof item?.id === 'string' ? item.id
      : typeof item?._id === 'string' ? item._id : '';
    itemsChecked += 1;
    const path = stitchedHlsPath(item);
    if (PLUTO_ID.test(plutoId) && path) {
      const contentKind = (Array.isArray(payload?.EPG) && payload.EPG.includes(item))
        ? 'channel' : contentKindFromItem(item);
      return Object.freeze({ plutoId, contentKind, itemsChecked, path });
    }
  }
  return Object.freeze({ plutoId: null, contentKind: null, itemsChecked, path: null });
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

const playbackPathFromItem = (item) => {
  const path = stitchedHlsPath(item);
  if (path) return path;
  const url = firstHlsUrl(item);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}`;
  } catch {
    return null;
  }
};

const exactItemFromPayload = (payload, plutoId) => {
  const items = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.items) ? payload.items : null;
  if (!items) return null;
  return items.find((item) => item && typeof item === 'object' &&
    (item.id === plutoId || item._id === plutoId)) || null;
};

const contentKindFromItem = (item) => {
  const declared = [item?.type, item?.contentType, item?.kind]
    .find((value) => typeof value === 'string')?.toLowerCase() || '';
  if (declared.includes('episode') || Number.isInteger(item?.episodeNumber) ||
      Number.isInteger(item?.episode)) return 'episode';
  if (declared.includes('movie') || declared.includes('film')) return 'movie';
  return firstHlsUrl(item) ? 'movie' : 'unknown';
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
  episodeBaseUrl = baseUrl === DEFAULT_BASE_URL ? DEFAULT_EPISODE_BASE_URL : baseUrl,
  bootUrl = DEFAULT_BOOT_URL,
  http,
  timeoutMs = 3_000,
  maxCandidates = 2,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 3,
  mediaMap = [],
  mappingStore = null,
  region = 'latam',
  supportsMovies = true,
  supportsEpisodes = true,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) => {
  const parsedBaseUrl = normalizeBaseUrl(baseUrl);
  const parsedEpisodeBaseUrl = normalizeBaseUrl(episodeBaseUrl);
  const parsedBootUrl = normalizeHttpUrl(bootUrl);
  const mappings = normalizeMediaMap(mediaMap);
  const normalizedRegion = typeof region === 'string' ? region.trim().toLowerCase() : '';
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean' ||
      typeof now !== 'function' || typeof randomUUID !== 'function' ||
      !REGION.test(normalizedRegion) ||
      (mappingStore !== null && typeof mappingStore?.findActiveMapping !== 'function') ||
      mappings === null || !parsedBootUrl ||
      (enabled && (!parsedBaseUrl || !parsedEpisodeBaseUrl))) {
    throw providerError(ERROR_CODES.INVALID_CONFIG);
  }
  const active = enabled === true && parsedBaseUrl !== null;
  const mappingByKey = new Map(mappings.map((entry) => [mediaKey(entry), entry]));
  const state = { token: '', expiresAt: 0, deviceId: randomUUID(), sessionId: randomUUID(),
    bootBytes: 0, bootItem: null, stitcherUrl: null, stitcherParams: '' };

  const requestJson = async (client, url, { headers = {}, signal, onResponse } = {}) => {
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
    const payload = safeJson(response);
    if (typeof onResponse === 'function') onResponse(response.body.length);
    return payload;
  };

  const boot = async (client, signal) => {
    if (state.token && state.expiresAt - SESSION_REFRESH_SKEW_MS > now()) {
      return state.token;
    }
    const payload = await requestJson(client, createBootUrl({
      bootUrl: parsedBootUrl, deviceId: state.deviceId, sessionId: state.sessionId,
    }), { signal, onResponse: (bytes) => { state.bootBytes = bytes; } });
    const token = typeof payload?.sessionToken === 'string' ? payload.sessionToken : '';
    if (!token) throw providerError(ERROR_CODES.INVALID_RESPONSE);
    const tokenExpiryIso = parseJwtExpiry(token);
    const tokenExpiry = tokenExpiryIso ? new Date(tokenExpiryIso).getTime() : 0;
    const fallbackExpiry = now() + DEFAULT_SESSION_TTL_MS;
    state.token = token;
    state.expiresAt = Math.min(
      tokenExpiry > now() ? tokenExpiry : fallbackExpiry,
      now() + MAX_SESSION_TTL_MS
    );
    state.bootItem = discoverBootItem(payload);
    state.stitcherUrl = normalizeBaseUrl(payload?.servers?.stitcher);
    state.stitcherParams = typeof payload?.stitcherParams === 'string' &&
      payload.stitcherParams.length <= 4096 ? payload.stitcherParams : '';
    return state.token;
  };

  const createCandidate = (url) => {
    if (!url) return null;
    let hasJwt = false;
    try { hasJwt = new URL(url).searchParams.has('jwt'); } catch { return null; }
    const expiresAt = hasJwt ? temporaryExpiryFromUrl(url, ['jwt']) : null;
    return normalizeEmbedCandidate({ providerId: id, url, headers: {},
      qualityHint: 'auto', expiresAt,
      urlSensitivity: hasJwt ? 'temporary_signed' : 'normal',
      metadata: { sourceType: 'pluto' } });
  };

  const buildSessionUrl = (item, token) => {
    if (!item?.path || !state.stitcherUrl || !token) return null;
    try {
      const relativePath = item.path.startsWith('/stitch/') ? `v2${item.path}` : item.path;
      const url = new URL(relativePath, state.stitcherUrl);
      for (const [name, value] of new URLSearchParams(state.stitcherParams)) {
        url.searchParams.set(name, value);
      }
      url.searchParams.set('jwt', token);
      url.searchParams.set('includeExtendedEvents', 'true');
      url.searchParams.set('masterJWTPassthrough', 'true');
      return normalizeHttpUrl(url.href);
    } catch {
      return null;
    }
  };

  const getExactItem = async (client, token, mapping, signal) => {
    const selectedBase = mapping.contentType === 'episode'
      ? parsedEpisodeBaseUrl : parsedBaseUrl;
    const basePath = selectedBase.pathname === '/' ? '' : selectedBase.pathname;
    const requestUrl = mapping.contentType === 'episode'
      ? new URL(`${basePath}/v2/episodes/${mapping.plutoId}/clips.json`, selectedBase.origin)
      : new URL(`${basePath}/v4/vod/items`, selectedBase.origin);
    if (mapping.contentType === 'movie') requestUrl.searchParams.set('ids', mapping.plutoId);
    const payload = await requestJson(client, requestUrl.href, {
      signal,
      headers: { authorization: `Bearer ${token}`, origin: 'https://pluto.tv',
        referer: 'https://pluto.tv/' },
    });
    if (payload === null) return null;
    if (mapping.contentType === 'episode') {
      const hasMetadata = (Array.isArray(payload) && payload.length > 0) ||
        (payload && typeof payload === 'object' && !Array.isArray(payload) &&
          Object.keys(payload).length > 0);
      return hasMetadata ? { id: mapping.plutoId, type: 'episode' } : null;
    }
    return exactItemFromPayload(payload, mapping.plutoId);
  };

  const discoverEpisode = async (runtime = {}) => {
    const empty = (itemsChecked = 0) => Object.freeze({ plutoId: null, season: null,
      episode: null, itemsChecked });
    if (!active || typeof runtime.seriesId !== 'string' ||
        !PLUTO_ID.test(runtime.seriesId)) return empty();
    const client = clientFrom(runtime);
    const token = await boot(client, runtime.signal);
    if (typeof runtime.onStage === 'function') runtime.onStage('boot');
    const basePath = parsedBaseUrl.pathname === '/' ? '' : parsedBaseUrl.pathname;
    const url = new URL(`${basePath}/v4/vod/series/${runtime.seriesId}/seasons`,
      parsedBaseUrl.origin);
    url.searchParams.set('offset', String(MAX_DISCOVERY_ITEMS));
    url.searchParams.set('page', '1');
    const payload = await requestJson(client, url.href, {
      signal: runtime.signal,
      headers: { authorization: `Bearer ${token}`, origin: 'https://pluto.tv',
        referer: 'https://pluto.tv/' },
    });
    const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const season = Array.isArray(root?.seasons) ? root.seasons[0] : null;
    const seasonNumber = Number.isInteger(season?.number) ? season.number : 1;
    const episodes = Array.isArray(season?.episodes)
      ? season.episodes.slice(0, MAX_DISCOVERY_ITEMS) : [];
    let itemsChecked = 0;
    for (const item of episodes) {
      itemsChecked += 1;
      const plutoId = typeof item?._id === 'string' ? item._id
        : typeof item?.id === 'string' ? item.id : '';
      if (!PLUTO_ID.test(plutoId)) continue;
      const episode = Number.isInteger(item?.number) ? item.number
        : Number.isInteger(item?.episode) ? item.episode
          : Number.isInteger(item?.episodeNumber) ? item.episodeNumber : itemsChecked;
      return Object.freeze({ plutoId, season: seasonNumber, episode, itemsChecked });
    }
    return empty(itemsChecked);
  };

  const clientFrom = (runtime) => {
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') {
      throw providerError(ERROR_CODES.INVALID_CONFIG);
    }
    return client;
  };

  const discoverPublicItem = async (runtime = {}) => {
    const empty = () => Object.freeze({ plutoId: null, contentKind: null,
      itemsChecked: 0, responseBytes: 0, endpointType: 'boot_epg' });
    if (!active) return empty();
    const client = clientFrom(runtime);
    await boot(client, runtime.signal);
    if (typeof runtime.onStage === 'function') runtime.onStage('boot');
    const item = state.bootItem || empty();
    const maxItems = Number.isInteger(runtime.maxItems) && runtime.maxItems >= 1
      ? Math.min(runtime.maxItems, MAX_DISCOVERY_ITEMS) : MAX_DISCOVERY_ITEMS;
    if (item.itemsChecked > maxItems) {
      return Object.freeze({ plutoId: null, contentKind: null, itemsChecked: maxItems,
        responseBytes: state.bootBytes, endpointType: 'boot_epg' });
    }
    return Object.freeze({ plutoId: item.plutoId, contentKind: item.contentKind,
      itemsChecked: Math.min(item.itemsChecked || 0, maxItems),
      responseBytes: state.bootBytes, endpointType: 'boot_epg' });
  };

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const configuredMapping = mappingByKey.get(mediaKey(mediaContext));
    const diagnosticId = (runtime.diagnosticSessionPlayback === true ||
      runtime.diagnosticExactItem === true) &&
      typeof runtime.temporaryPlutoId === 'string' && PLUTO_ID.test(runtime.temporaryPlutoId)
      ? runtime.temporaryPlutoId : null;
    let mapping = configuredMapping || (diagnosticId ? {
      contentType: mediaContext.contentType,
      tmdbId: mediaContext.tmdbId,
      ...(mediaContext.contentType === 'episode'
        ? { season: mediaContext.season, episode: mediaContext.episode } : {}),
      plutoId: diagnosticId,
    } : null);
    if (!mapping && mappingStore && mediaContext.contentType === 'movie') {
      const stored = await mappingStore.findActiveMapping({ providerId: 'pluto',
        region: normalizedRegion, contentType: 'movie', tmdbId: mediaContext.tmdbId });
      const activeStored = stored && (stored.status === undefined || stored.status === 'active');
      const externalId = activeStored && typeof stored.external_id === 'string'
        ? stored.external_id : activeStored && typeof stored.externalId === 'string'
          ? stored.externalId : '';
      if (PLUTO_ID.test(externalId)) {
        mapping = { contentType: 'movie', tmdbId: mediaContext.tmdbId, plutoId: externalId };
      }
    }
    if (!mapping) return [];
    const client = clientFrom(runtime);
    const token = await boot(client, runtime.signal);
    if (runtime.diagnosticSessionPlayback === true &&
        state.bootItem?.plutoId === mapping.plutoId) {
      const url = buildSessionUrl(state.bootItem, token);
      const candidate = createCandidate(url);
      return candidate ? [candidate] : [];
    }
    const item = await getExactItem(client, token, mapping, runtime.signal);
    if (!item) return [];
    const path = playbackPathFromItem(item) || (mapping.contentType === 'episode'
      ? `/stitch/hls/episode/${mapping.plutoId}/master.m3u8` : null);
    const url = buildSessionUrl(path ? { path } : null, token);
    if (!url) return [];
    const candidate = createCandidate(url);
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
    discoverEpisode,
    discoverPublicItem,
    getSources,
  });
};

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_BOOT_URL,
  DEFAULT_EPISODE_BASE_URL,
  ERROR_CODES,
  MAX_DISCOVERY_ITEMS,
  MAX_MAPPINGS,
  createPlutoSourceProvider,
  discoverBootItem,
  exactItemFromPayload,
  firstHlsUrl,
  normalizeMediaMap,
  playbackPathFromItem,
};
