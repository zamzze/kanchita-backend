'use strict';

const { safeJsonObject } = require('../../db/bulkPersistence.validation');

const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const URL = /https?:\/\//i;
const RESULT_FIELDS = new Set(['providerId', 'externalId', 'region',
  'providerTitle', 'providerSlug', 'matchMethod', 'matchConfidence', 'metadata']);
const label = (value, max) => value == null ? null :
  typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= max && !/[\r\n]/.test(value) && !URL.test(value)
    ? value.trim() : undefined;

const normalizeMedia = (input) => {
  if (!input || !['movie', 'episode'].includes(input.contentType) ||
      !Number.isSafeInteger(input.tmdbId) || input.tmdbId < 1 ||
      typeof input.title !== 'string' || !input.title.trim() ||
      input.title.length > 255 ||
      (input.originalTitle != null &&
        (typeof input.originalTitle !== 'string' || input.originalTitle.length > 255)) ||
      (input.year != null && (!Number.isInteger(input.year) ||
        input.year < 1900 || input.year > 2100))) return null;
  if (input.contentType === 'episode') {
    if (!Number.isInteger(input.season) || input.season < 0 ||
        !Number.isInteger(input.episode) || input.episode < 1) return null;
  } else if (input.season != null || input.episode != null) return null;
  return Object.freeze({ contentType: input.contentType, tmdbId: input.tmdbId,
    title: input.title.trim(), originalTitle: input.originalTitle?.trim() || null,
    year: input.year ?? null,
    ...(input.contentType === 'episode'
      ? { season: input.season, episode: input.episode } : {}) });
};

const normalizeMappingResult = (descriptor, media, raw, verifiedAt = new Date()) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !RESULT_FIELDS.has(key)) ||
      raw.providerId !== descriptor.id ||
      (raw.region != null && !REGION.test(raw.region)) ||
      !Number.isFinite(verifiedAt.getTime())) return null;
  const externalId = label(raw.externalId, 256);
  const providerTitle = label(raw.providerTitle, 512);
  const providerSlug = label(raw.providerSlug, 512);
  const matchMethod = label(raw.matchMethod, 64);
  const confidence = raw.matchConfidence == null ? null : Number(raw.matchConfidence);
  const metadata = safeJsonObject(raw.metadata);
  if (!externalId || providerTitle === undefined || providerSlug === undefined ||
      matchMethod === undefined || !metadata ||
      (confidence !== null && (!Number.isFinite(confidence) ||
        confidence < 0 || confidence > 100))) return null;
  return Object.freeze({ providerId: descriptor.id,
    region: raw.region || descriptor.region,
    contentType: media.contentType, tmdbId: media.tmdbId,
    seasonNumber: media.contentType === 'episode' ? media.season : null,
    episodeNumber: media.contentType === 'episode' ? media.episode : null,
    externalId, providerTitle, providerSlug,
    matchMethod: matchMethod || 'provider_discovery', matchConfidence: confidence,
    metadata, status: 'active', lastVerifiedAt: verifiedAt });
};

module.exports = { ID, REGION, normalizeMedia, normalizeMappingResult };
