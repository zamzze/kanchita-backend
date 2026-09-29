'use strict';

const { normalizeIdentity } = require('../../providerMediaMappingResolver');
const { normalizeEmbedCandidate } = require('../resolverContracts');
const { playbackHeadersOrNull } = require('../../playbackHeaders');
const { safeHeaders, safeHttpUrl, safeJsonObject, uuid } =
  require('../../../../db/bulkPersistence.validation');

const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_MAPPING_ATTEMPTS = 8;
const MAX_CANDIDATES = 32;
const MAX_SOURCE_ROWS = 64;

const sourceOptionIdentity = (candidate) => JSON.stringify([
  candidate.url,
  Object.entries(candidate.headers).sort(([a], [b]) => a.localeCompare(b)),
  candidate.languageHint,
  candidate.qualityHint,
  candidate.metadata.variant ?? null,
  candidate.metadata.source ?? null,
  candidate.metadata.sourcePriority ?? null,
]);

const sourceCandidate = (row, mappingId, providerId) => {
  if (!row || row.status !== 'active' || row.source_type !== 'direct_hls' ||
      String(row.mapping_id) !== String(mappingId) || !uuid(row.id)) return null;
  const url = safeHttpUrl(row.source_url);
  const headers = safeHeaders(row.headers_json);
  const sourceMetadata = safeJsonObject(row.metadata);
  if (!url || !headers || sourceMetadata === null) return null;
  const playbackHeaders = playbackHeadersOrNull(headers);
  if (!playbackHeaders) return null;
  const variant = sourceMetadata.variant;
  const source = sourceMetadata.source;
  const sourcePriority = sourceMetadata.sourcePriority;
  const metadata = { persistedSourceId: row.id, sourceType: 'direct_hls', mappingId };
  if (typeof variant === 'string' && variant.length <= 128) metadata.variant = variant;
  if (typeof source === 'string' && source.length <= 128) metadata.source = source;
  if (Number.isInteger(sourcePriority) && sourcePriority >= -1_000_000 &&
      sourcePriority <= 1_000_000) metadata.sourcePriority = sourcePriority;
  return normalizeEmbedCandidate({
    providerId,
    url,
    headers: playbackHeaders,
    languageHint: row.language,
    qualityHint: row.quality,
    metadata,
  });
};

const createPersistedProviderSourceProvider = ({
  id,
  region,
  mappingResolver,
  sourceStore,
  enabled = false,
  priority = 100,
  timeoutMs = 2_000,
  maxCandidates = 8,
  maxMappingAttempts = 3,
  supportsMovies = true,
  supportsEpisodes = true,
} = {}) => {
  const providerId = typeof id === 'string' ? id.trim().toLowerCase() : '';
  const normalizedRegion = typeof region === 'string' ? region.trim().toLowerCase() : '';
  if (!ID.test(providerId) || !REGION.test(normalizedRegion) ||
      !mappingResolver || typeof mappingResolver.resolve !== 'function' ||
      !sourceStore || typeof sourceStore.findActiveSourcesForMapping !== 'function' ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) ||
      Math.abs(priority) > 1_000_000 || !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 10_000 || !Number.isInteger(maxCandidates) ||
      maxCandidates < 1 || maxCandidates > MAX_CANDIDATES ||
      !Number.isInteger(maxMappingAttempts) || maxMappingAttempts < 1 ||
      maxMappingAttempts > MAX_MAPPING_ATTEMPTS ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean') {
    throw new Error('PERSISTED_SOURCE_INVALID_CONFIG');
  }

  const getSources = async (mediaContext, runtime = {}) => {
    if (!enabled || runtime.signal?.aborted) return [];
    const identity = normalizeIdentity({ providerId, region: normalizedRegion, mediaContext });
    if (!identity || identity.contentType === 'series' ||
        identity.contentType === 'movie' && !supportsMovies ||
        identity.contentType === 'episode' && !supportsEpisodes) return [];
    const refs = await mappingResolver.resolve({ providerId, region: normalizedRegion,
      mediaContext });
    if (!Array.isArray(refs)) return [];
    const candidates = [];
    const seen = new Set();
    for (const ref of refs.slice(0, maxMappingAttempts)) {
      if (runtime.signal?.aborted) break;
      if (ref?.providerId !== providerId || ref.region !== normalizedRegion ||
          ref.contentType !== identity.contentType || ref.tmdbId !== identity.tmdbId ||
          ref.seasonNumber !== identity.seasonNumber ||
          ref.episodeNumber !== identity.episodeNumber ||
          !Number.isSafeInteger(ref.mappingId) || ref.mappingId < 1) continue;
      const rows = await sourceStore.findActiveSourcesForMapping(ref.mappingId,
        { sourceType: 'direct_hls', limit: MAX_SOURCE_ROWS });
      if (!Array.isArray(rows)) continue;
      for (const row of rows.slice(0, MAX_SOURCE_ROWS)) {
        const candidate = sourceCandidate(row, ref.mappingId, providerId);
        if (!candidate) continue;
        const key = sourceOptionIdentity(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
        if (candidates.length >= maxCandidates) return candidates;
      }
    }
    return candidates;
  };

  return Object.freeze({
    descriptor: Object.freeze({ id: providerId, active: enabled, priority,
      supportsMovies, supportsEpisodes, languages: Object.freeze([]),
      strategy: 'static', timeoutMs, maxCandidates }),
    getSources,
  });
};

module.exports = { createPersistedProviderSourceProvider, sourceCandidate };
