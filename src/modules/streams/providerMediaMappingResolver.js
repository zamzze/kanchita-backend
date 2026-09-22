'use strict';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CONTENT_TYPES = new Set(['movie', 'episode']);
const HARD_MAX_MAPPINGS = 32;
const DEFAULT_MAX_MAPPINGS = 8;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_ITEMS = 512;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneJsonValue = (value, state) => {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || state.depth > MAX_METADATA_DEPTH) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value) && !isPlainObject(value)) return undefined;
  if (state.seen.has(value)) return undefined;
  state.seen.add(value);
  const next = { depth: state.depth + 1, items: state.items, seen: state.seen };
  const copy = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if ((!Array.isArray(value) && (UNSAFE_KEYS.has(key) || !key || key.length > 128))) {
      state.seen.delete(value);
      return undefined;
    }
    const cloned = cloneJsonValue(item, next);
    if (cloned === undefined) {
      state.seen.delete(value);
      return undefined;
    }
    copy[key] = cloned;
  }
  state.items = next.items;
  state.seen.delete(value);
  return copy;
};

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const normalizeMetadata = (value) => {
  if (value === undefined || value === null) return Object.freeze({});
  if (!isPlainObject(value)) return null;
  const cloned = cloneJsonValue(value, { depth: 0, items: 0, seen: new Set() });
  return cloned === undefined ? null : deepFreeze(cloned);
};

const normalizeIdentity = ({ providerId, region, mediaContext } = {}) => {
  const normalizedProvider = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const normalizedRegion = typeof region === 'string' ? region.trim().toLowerCase() : '';
  if (!PROVIDER_ID.test(normalizedProvider) || !REGION.test(normalizedRegion) ||
      !isPlainObject(mediaContext) || !CONTENT_TYPES.has(mediaContext.contentType) ||
      !Number.isInteger(mediaContext.tmdbId) || mediaContext.tmdbId < 1) return null;
  if (mediaContext.contentType === 'movie') {
    if (mediaContext.season != null || mediaContext.episode != null) return null;
    return Object.freeze({ providerId: normalizedProvider, region: normalizedRegion,
      contentType: 'movie', tmdbId: mediaContext.tmdbId,
      seasonNumber: null, episodeNumber: null });
  }
  if (!Number.isInteger(mediaContext.season) || mediaContext.season < 0 ||
      !Number.isInteger(mediaContext.episode) || mediaContext.episode < 1) return null;
  return Object.freeze({ providerId: normalizedProvider, region: normalizedRegion,
    contentType: 'episode', tmdbId: mediaContext.tmdbId,
    seasonNumber: mediaContext.season, episodeNumber: mediaContext.episode });
};

const positiveMappingId = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
};

const optionalString = (value, maxLength) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

const normalizeVerifiedAt = (value) => {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const normalizeMappingRow = (row, identity) => {
  if (!isPlainObject(row)) return null;
  const mappingId = positiveMappingId(row.id);
  const externalId = typeof row.external_id === 'string' ? row.external_id.trim() : '';
  const providerTitle = optionalString(row.provider_title, 512);
  const providerSlug = optionalString(row.provider_slug, 512);
  const matchMethod = optionalString(row.match_method, 64);
  const confidence = row.match_confidence == null ? null : Number(row.match_confidence);
  const metadata = normalizeMetadata(row.metadata);
  const lastVerifiedAt = normalizeVerifiedAt(row.last_verified_at);
  if (!mappingId || !externalId || externalId.length > 256 ||
      row.provider_id !== identity.providerId || row.region !== identity.region ||
      row.content_type !== identity.contentType || row.tmdb_id !== identity.tmdbId ||
      row.season_number !== identity.seasonNumber ||
      row.episode_number !== identity.episodeNumber || providerTitle === undefined ||
      providerSlug === undefined || matchMethod === undefined || metadata === null ||
      lastVerifiedAt === undefined || (confidence !== null &&
        (!Number.isFinite(confidence) || confidence < 0 || confidence > 100))) return null;
  return Object.freeze({
    mappingId,
    providerId: identity.providerId,
    region: identity.region,
    contentType: identity.contentType,
    tmdbId: identity.tmdbId,
    externalId,
    seasonNumber: identity.seasonNumber,
    episodeNumber: identity.episodeNumber,
    providerTitle,
    providerSlug,
    matchMethod,
    matchConfidence: confidence,
    metadata,
    lastVerifiedAt,
  });
};

const createProviderMediaMappingResolver = ({ store, maxMappings = DEFAULT_MAX_MAPPINGS } = {}) => {
  if (!store || typeof store.findActiveMappings !== 'function') {
    throw new Error('PROVIDER_MAPPING_RESOLVER_INVALID_STORE');
  }
  if (!Number.isInteger(maxMappings) || maxMappings < 1 || maxMappings > HARD_MAX_MAPPINGS) {
    throw new Error('PROVIDER_MAPPING_RESOLVER_INVALID_MAX_MAPPINGS');
  }
  const resolve = async (input) => {
    const identity = normalizeIdentity(input);
    if (!identity) return Object.freeze([]);
    const rows = await store.findActiveMappings(identity);
    if (!Array.isArray(rows)) return Object.freeze([]);
    const refs = [];
    for (const row of rows) {
      const ref = normalizeMappingRow(row, identity);
      if (ref) refs.push(ref);
      if (refs.length >= maxMappings) break;
    }
    return Object.freeze(refs);
  };
  return Object.freeze({ resolve });
};

module.exports = {
  DEFAULT_MAX_MAPPINGS,
  HARD_MAX_MAPPINGS,
  createProviderMediaMappingResolver,
  normalizeIdentity,
  normalizeMappingRow,
};
