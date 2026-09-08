'use strict';

const CONTENT_TYPES = Object.freeze(['movie', 'episode']);
const STREAM_PROTOCOLS = Object.freeze(['hls', 'mp4', 'dash', 'unknown']);

const contentTypes = new Set(CONTENT_TYPES);
const streamProtocols = new Set(STREAM_PROTOCOLS);
const MAX_ID_LENGTH = 128;
const MAX_CONTENT_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 512;
const MAX_URL_LENGTH = 16_384;
const MAX_HEADER_COUNT = 64;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_ITEMS = 512;

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeRequiredString = (value, maxLength = MAX_TEXT_LENGTH) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
};

const normalizeOptionalString = (value, maxLength = MAX_TEXT_LENGTH) => {
  if (value === undefined || value === null || value === '') return null;
  return normalizeRequiredString(value, maxLength);
};

const normalizeHttpUrl = (value) => {
  const normalized = normalizeRequiredString(value, MAX_URL_LENGTH);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
};

const normalizeHeaders = (value) => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADER_COUNT) return null;

  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = normalizeRequiredString(rawName, 128)?.toLowerCase();
    if (!name || typeof rawValue !== 'string' || /[\r\n]/.test(rawName + rawValue)) {
      return null;
    }
    const headerValue = rawValue.trim();
    if (headerValue.length > 8_192) return null;
    headers[name] = headerValue;
  }
  return headers;
};

const cloneJsonLike = (value, state = { depth: 0, items: 0, seen: new Set() }) => {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || state.depth > MAX_METADATA_DEPTH) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value) && !isPlainObject(value)) return undefined;
  if (state.seen.has(value)) return undefined;

  state.seen.add(value);
  const childState = { ...state, depth: state.depth + 1 };
  let clone;
  if (Array.isArray(value)) {
    clone = [];
    for (const item of value) {
      const copied = cloneJsonLike(item, childState);
      if (copied === undefined) {
        state.seen.delete(value);
        return undefined;
      }
      clone.push(copied);
    }
  } else {
    clone = {};
    for (const [key, item] of Object.entries(value)) {
      if (!normalizeRequiredString(key, 128)) {
        state.seen.delete(value);
        return undefined;
      }
      const copied = cloneJsonLike(item, childState);
      if (copied === undefined) {
        state.seen.delete(value);
        return undefined;
      }
      clone[key] = copied;
    }
  }
  state.items = childState.items;
  state.seen.delete(value);
  return clone;
};

const normalizePositiveInteger = (value) =>
  Number.isInteger(value) && value > 0 ? value : null;

const normalizeMediaContext = (input) => {
  if (!isPlainObject(input) || !contentTypes.has(input.contentType)) return null;
  if (typeof input.contentId !== 'string' || !input.contentId.trim() ||
      input.contentId.length > MAX_CONTENT_ID_LENGTH) return null;

  const tmdbId = normalizePositiveInteger(input.tmdbId);
  const title = normalizeRequiredString(input.title);
  if (!tmdbId || !title) return null;

  let season = null;
  let episode = null;
  if (input.contentType === 'episode') {
    season = normalizePositiveInteger(input.season);
    episode = normalizePositiveInteger(input.episode);
    if (!season || !episode) return null;
  } else if ((input.season !== undefined && input.season !== null) ||
             (input.episode !== undefined && input.episode !== null)) {
    return null;
  }

  return {
    contentType: input.contentType,
    contentId: input.contentId,
    tmdbId,
    title,
    season,
    episode,
  };
};

const normalizeEmbedCandidate = (input) => {
  if (!isPlainObject(input)) return null;
  const providerId = normalizeRequiredString(input.providerId, MAX_ID_LENGTH);
  const url = normalizeHttpUrl(input.url);
  const referer = input.referer === undefined || input.referer === null
    ? null : normalizeHttpUrl(input.referer);
  const origin = input.origin === undefined || input.origin === null
    ? null : normalizeHttpUrl(input.origin);
  const headers = normalizeHeaders(input.headers);
  const languageHint = normalizeOptionalString(input.languageHint, 64);
  const qualityHint = normalizeOptionalString(input.qualityHint, 64);
  const metadata = input.metadata === undefined || input.metadata === null
    ? null : cloneJsonLike(input.metadata);

  if (!providerId || !url || headers === null ||
      (input.referer != null && !referer) || (input.origin != null && !origin) ||
      (input.languageHint != null && !languageHint) ||
      (input.qualityHint != null && !qualityHint) ||
      (input.metadata != null && metadata === undefined)) return null;

  return { providerId, url, referer, origin, headers, languageHint, qualityHint, metadata };
};

const normalizeStreamCandidate = (input) => {
  if (!isPlainObject(input)) return null;
  const url = normalizeHttpUrl(input.url);
  const providerId = normalizeRequiredString(input.providerId, MAX_ID_LENGTH);
  const resolverId = normalizeRequiredString(input.resolverId, MAX_ID_LENGTH);
  const headers = normalizeHeaders(input.headers);
  if (!url || !providerId || !resolverId || !streamProtocols.has(input.protocol) ||
      headers === null) return null;

  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const parsed = input.expiresAt instanceof Date
      ? new Date(input.expiresAt.getTime()) : new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) return null;
    expiresAt = parsed.toISOString();
  }

  const latencyMs = input.latencyMs === undefined || input.latencyMs === null
    ? null : input.latencyMs;
  if (latencyMs !== null && (!Number.isFinite(latencyMs) || latencyMs < 0)) return null;
  if (input.validated !== undefined && typeof input.validated !== 'boolean') return null;

  const quality = normalizeOptionalString(input.quality, 64);
  const audioLanguage = normalizeOptionalString(input.audioLanguage, 64);
  const subtitleLanguage = normalizeOptionalString(input.subtitleLanguage, 64);
  if ((input.quality != null && !quality) || (input.audioLanguage != null && !audioLanguage) ||
      (input.subtitleLanguage != null && !subtitleLanguage)) return null;

  const hlsInfo = input.hlsInfo === undefined || input.hlsInfo === null
    ? null : cloneJsonLike(input.hlsInfo);
  if (input.hlsInfo != null && hlsInfo === undefined) return null;

  return {
    url,
    protocol: input.protocol,
    providerId,
    resolverId,
    headers,
    expiresAt,
    latencyMs,
    validated: input.validated ?? false,
    quality,
    audioLanguage,
    subtitleLanguage,
    hlsInfo,
  };
};

const normalizeStringList = (value, { lowerCase = false, maxLength = 256 } = {}) => {
  if (!Array.isArray(value)) return null;
  const result = [];
  const seen = new Set();
  for (const item of value) {
    let normalized = normalizeRequiredString(item, maxLength);
    if (!normalized) return null;
    if (lowerCase) normalized = normalized.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
};

const normalizeResolverDescriptor = (input) => {
  if (!isPlainObject(input)) return null;
  const id = normalizeRequiredString(input.id, MAX_ID_LENGTH);
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id) || typeof input.active !== 'boolean' ||
      typeof input.requiresBrowser !== 'boolean' || !Number.isInteger(input.priority)) return null;

  const protocols = normalizeStringList(input.protocols, { lowerCase: true, maxLength: 16 });
  const domains = normalizeStringList(input.domains, { lowerCase: true, maxLength: 253 });
  const aliases = normalizeStringList(input.aliases, { lowerCase: true, maxLength: MAX_ID_LENGTH });
  const urlPatterns = normalizeStringList(input.urlPatterns, { maxLength: 512 });
  if (!protocols || !domains || !aliases || !urlPatterns ||
      protocols.some((protocol) => !streamProtocols.has(protocol)) ||
      domains.some((domain) => !/^(?:\*\.)?[a-z0-9.-]+$/i.test(domain))) return null;

  return {
    id: id.toLowerCase(),
    active: input.active,
    priority: input.priority,
    protocols,
    domains,
    aliases,
    urlPatterns,
    requiresBrowser: input.requiresBrowser,
  };
};

const isValidMediaContext = (input) => normalizeMediaContext(input) !== null;
const isValidEmbedCandidate = (input) => normalizeEmbedCandidate(input) !== null;
const isValidStreamCandidate = (input) => normalizeStreamCandidate(input) !== null;
const isValidResolverDescriptor = (input) => normalizeResolverDescriptor(input) !== null;

module.exports = {
  CONTENT_TYPES,
  STREAM_PROTOCOLS,
  normalizeMediaContext,
  normalizeEmbedCandidate,
  normalizeStreamCandidate,
  normalizeResolverDescriptor,
  isValidMediaContext,
  isValidEmbedCandidate,
  isValidStreamCandidate,
  isValidResolverDescriptor,
};
