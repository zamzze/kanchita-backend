'use strict';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const STATUSES = new Set(['active', 'inactive', 'review']);
const CONTENT_TYPES = new Set(['movie', 'episode']);

const mappingColumns = `id, provider_id, region, content_type, tmdb_id,
  season_number, episode_number, external_id, provider_title, provider_slug,
  match_method, match_confidence, status, metadata, first_seen_at, last_seen_at,
  last_verified_at, created_at, updated_at`;

const normalizeLookup = (input, { requireStatus = false } = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim().toLowerCase() : '';
  const region = typeof input.region === 'string' ? input.region.trim().toLowerCase() : '';
  const { contentType, tmdbId } = input;
  const status = input.status === undefined ? null : input.status;
  if (!PROVIDER_ID.test(providerId) || !REGION.test(region) ||
      !CONTENT_TYPES.has(contentType) || !Number.isInteger(tmdbId) || tmdbId < 1 ||
      (requireStatus && !STATUSES.has(status)) || (status !== null && !STATUSES.has(status))) {
    return null;
  }
  if (contentType === 'episode') {
    if (!Number.isInteger(input.seasonNumber) || input.seasonNumber < 0 ||
        !Number.isInteger(input.episodeNumber) || input.episodeNumber < 1) return null;
  } else if (input.seasonNumber != null || input.episodeNumber != null) return null;
  return { providerId, region, contentType, tmdbId,
    seasonNumber: contentType === 'episode' ? input.seasonNumber : null,
    episodeNumber: contentType === 'episode' ? input.episodeNumber : null,
    status };
};

const jsonObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? value : {};

const normalizeMapping = (input) => {
  const lookup = normalizeLookup({ ...input, status: input?.status || 'active' },
    { requireStatus: true });
  const externalId = typeof input?.externalId === 'string' ? input.externalId.trim() : '';
  if (!lookup || !externalId || externalId.length > 256) return null;
  const optional = (name, max) => input[name] == null || input[name] === '' ? null
    : typeof input[name] === 'string' && input[name].trim().length <= max
      ? input[name].trim() : undefined;
  const providerTitle = optional('providerTitle', 512);
  const providerSlug = optional('providerSlug', 512);
  const matchMethod = optional('matchMethod', 64);
  const confidence = input.matchConfidence == null ? null : Number(input.matchConfidence);
  if (providerTitle === undefined || providerSlug === undefined || matchMethod === undefined ||
      (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100))) {
    return null;
  }
  return { ...lookup, externalId, providerTitle, providerSlug, matchMethod,
    matchConfidence: confidence, metadata: jsonObject(input.metadata),
    lastSeenAt: input.lastSeenAt || null, lastVerifiedAt: input.lastVerifiedAt || null };
};

const createProviderMediaMappingStore = (db = null) => {
  const activeDb = db || require('../config/db');
  if (!activeDb || typeof activeDb.query !== 'function') {
    throw new Error('MAPPING_STORE_INVALID_DB');
  }

  const queryMappings = async (input, activeOnly) => {
    const lookup = normalizeLookup({ ...input, status: activeOnly ? 'active' : input?.status },
      { requireStatus: activeOnly });
    if (!lookup) throw new Error('MAPPING_STORE_INVALID_LOOKUP');
    const values = [lookup.providerId, lookup.region, lookup.contentType, lookup.tmdbId,
      lookup.seasonNumber, lookup.episodeNumber];
    const statusClause = activeOnly ? "AND status = 'active'"
      : lookup.status ? 'AND status = $7' : '';
    if (!activeOnly && lookup.status) values.push(lookup.status);
    const { rows } = await activeDb.query(
      `SELECT ${mappingColumns}
       FROM provider_media_mappings
       WHERE provider_id = $1 AND region = $2 AND content_type = $3 AND tmdb_id = $4
         AND season_number IS NOT DISTINCT FROM $5
         AND episode_number IS NOT DISTINCT FROM $6
         ${statusClause}
       ORDER BY last_verified_at DESC NULLS LAST, updated_at DESC, id DESC`,
      values
    );
    return rows;
  };

  const findActiveMappings = (input) => queryMappings(input, true);
  const findActiveMapping = async (input) => (await findActiveMappings(input))[0] || null;
  const findMappings = (input) => queryMappings(input, false);

  const upsertMapping = async (input) => {
    const mapping = normalizeMapping(input);
    if (!mapping) throw new Error('MAPPING_STORE_INVALID_MAPPING');
    const values = [mapping.providerId, mapping.region, mapping.contentType, mapping.tmdbId,
      mapping.seasonNumber, mapping.episodeNumber, mapping.externalId, mapping.providerTitle,
      mapping.providerSlug, mapping.matchMethod, mapping.matchConfidence, mapping.status,
      mapping.metadata, mapping.lastSeenAt, mapping.lastVerifiedAt];
    const { rows } = await activeDb.query(
      `INSERT INTO provider_media_mappings (
         provider_id, region, content_type, tmdb_id, season_number, episode_number,
         external_id, provider_title, provider_slug, match_method, match_confidence,
         status, metadata, last_seen_at, last_verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       ON CONFLICT (provider_id, region, content_type, external_id) DO UPDATE SET
         tmdb_id = EXCLUDED.tmdb_id,
         season_number = EXCLUDED.season_number,
         episode_number = EXCLUDED.episode_number,
         provider_title = EXCLUDED.provider_title,
         provider_slug = EXCLUDED.provider_slug,
         match_method = EXCLUDED.match_method,
         match_confidence = EXCLUDED.match_confidence,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         last_seen_at = EXCLUDED.last_seen_at,
         last_verified_at = EXCLUDED.last_verified_at,
         updated_at = NOW()
       WHERE (provider_media_mappings.tmdb_id, provider_media_mappings.season_number,
              provider_media_mappings.episode_number, provider_media_mappings.provider_title,
              provider_media_mappings.provider_slug, provider_media_mappings.match_method,
              provider_media_mappings.match_confidence, provider_media_mappings.status,
              provider_media_mappings.metadata, provider_media_mappings.last_seen_at,
              provider_media_mappings.last_verified_at)
         IS DISTINCT FROM
             (EXCLUDED.tmdb_id, EXCLUDED.season_number, EXCLUDED.episode_number,
              EXCLUDED.provider_title, EXCLUDED.provider_slug, EXCLUDED.match_method,
              EXCLUDED.match_confidence, EXCLUDED.status, EXCLUDED.metadata,
              EXCLUDED.last_seen_at, EXCLUDED.last_verified_at)
         AND provider_media_mappings.tmdb_id = EXCLUDED.tmdb_id
         AND provider_media_mappings.season_number IS NOT DISTINCT FROM EXCLUDED.season_number
         AND provider_media_mappings.episode_number IS NOT DISTINCT FROM EXCLUDED.episode_number
       RETURNING ${mappingColumns}, (xmax = 0) AS inserted`,
      [...values.slice(0, 12), JSON.stringify(values[12]), ...values.slice(13)]
    );
    if (rows[0]) return { ...rows[0], change: rows[0].inserted ? 'inserted' : 'updated' };
    const existing = await activeDb.query(
      `SELECT ${mappingColumns}
       FROM provider_media_mappings
       WHERE provider_id = $1 AND region = $2 AND content_type = $3 AND external_id = $4`,
      [mapping.providerId, mapping.region, mapping.contentType, mapping.externalId]
    );
    if (!existing.rows[0]) return null;
    const row = existing.rows[0];
    const sameTarget = row.tmdb_id === mapping.tmdbId &&
      row.season_number === mapping.seasonNumber && row.episode_number === mapping.episodeNumber;
    return { ...row, change: sameTarget ? 'unchanged' : 'conflict' };
  };

  const markInactive = async ({ providerId, region, contentType, externalId }) => {
    const normalized = normalizeLookup({ providerId, region, contentType, tmdbId: 1,
      ...(contentType === 'episode' ? { seasonNumber: 0, episodeNumber: 1 } : {}) });
    if (!normalized || typeof externalId !== 'string' || !externalId.trim() ||
        externalId.trim().length > 256) {
      throw new Error('MAPPING_STORE_INVALID_IDENTITY');
    }
    const { rows } = await activeDb.query(
      `UPDATE provider_media_mappings
       SET status = 'inactive', updated_at = NOW()
       WHERE provider_id = $1 AND region = $2 AND content_type = $3 AND external_id = $4
       RETURNING ${mappingColumns}`,
      [normalized.providerId, normalized.region, normalized.contentType, externalId.trim()]
    );
    return rows[0] || null;
  };

  return Object.freeze({ findActiveMapping, findActiveMappings, findMappings,
    upsertMapping, markInactive });
};

module.exports = { createProviderMediaMappingStore, normalizeLookup, normalizeMapping };
