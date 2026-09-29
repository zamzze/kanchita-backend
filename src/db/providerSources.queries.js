'use strict';

const { IDENTIFIER, errorCode, identityHash, invalid, positiveId, safeHeaders,
  safeHttpUrl, safeJsonObject, shortLabel, timestamp, uuid } = require('./bulkPersistence.validation');

const TYPES = new Set(['embed', 'direct_hls', 'direct_mp4', 'api']);
const STATUSES = new Set(['active', 'stale', 'broken', 'refresh_required', 'disabled']);

const normalizeSource = (input) => {
  const mappingId = input?.mappingId;
  const sourceType = input?.sourceType;
  const sourceUrl = safeHttpUrl(input?.sourceUrl);
  const resolverId = shortLabel(input?.resolverId);
  const language = shortLabel(input?.language, 32);
  const quality = shortLabel(input?.quality, 32);
  const headers = safeHeaders(input?.headers);
  const metadata = safeJsonObject(input?.metadata);
  const status = input?.status ?? 'active';
  const verifiedAt = timestamp(input?.lastVerifiedAt);
  if (!positiveId(mappingId) || !TYPES.has(sourceType) || !sourceUrl ||
      (resolverId !== null && (resolverId === undefined || !IDENTIFIER.test(resolverId))) ||
      language === undefined || quality === undefined || !headers || !metadata ||
      !STATUSES.has(status) || verifiedAt === undefined) return null;
  return Object.freeze({ mappingId, sourceType, sourceUrl, resolverId, language,
    quality, headers, metadata, status, lastVerifiedAt: verifiedAt,
    sourceKey: identityHash(sourceType, sourceUrl, resolverId, language, quality) });
};

const createProviderSourceStore = (db) => {
  if (!db || typeof db.query !== 'function') throw invalid('PROVIDER_SOURCE_INVALID_DB');
  const upsertSource = async (input) => {
    const source = normalizeSource(input);
    if (!source) throw invalid('PROVIDER_SOURCE_INVALID_INPUT');
    const { rows } = await db.query(`
      INSERT INTO provider_sources (mapping_id, source_key, source_url, source_type,
        resolver_id, language, quality, headers_json, status, last_verified_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)
      ON CONFLICT (mapping_id, source_key) DO UPDATE SET
        headers_json = EXCLUDED.headers_json,
        status = EXCLUDED.status,
        last_verified_at = EXCLUDED.last_verified_at,
        metadata = EXCLUDED.metadata,
        failure_count = 0,
        last_error_code = NULL,
        updated_at = NOW()
      RETURNING *`, [source.mappingId, source.sourceKey, source.sourceUrl,
      source.sourceType, source.resolverId, source.language, source.quality,
      JSON.stringify(source.headers), source.status, source.lastVerifiedAt,
      JSON.stringify(source.metadata)]);
    return rows[0];
  };
  const findActiveSourcesForMapping = async (mappingId, { limit, sourceType } = {}) => {
    if (!positiveId(mappingId)) throw invalid('PROVIDER_SOURCE_INVALID_ID');
    if (limit !== undefined &&
        (!Number.isInteger(limit) || limit < 1 || limit > 64)) {
      throw invalid('PROVIDER_SOURCE_INVALID_LIMIT');
    }
    if (sourceType !== undefined && !TYPES.has(sourceType)) {
      throw invalid('PROVIDER_SOURCE_INVALID_TYPE');
    }
    const values = [mappingId];
    const typeClause = sourceType === undefined ? ''
      : ` AND source_type = $${values.push(sourceType)}`;
    const limitClause = limit === undefined ? '' : ` LIMIT $${values.push(limit)}`;
    const { rows } = await db.query(`SELECT * FROM provider_sources
      WHERE mapping_id = $1 AND status = 'active'
      ${typeClause}
      ORDER BY discovered_at DESC, id${limitClause}`, values);
    return rows;
  };
  const markSourceStatus = async ({ sourceId, status }) => {
    if (!uuid(sourceId) || !STATUSES.has(status)) throw invalid('PROVIDER_SOURCE_INVALID_STATUS');
    const { rows } = await db.query(`UPDATE provider_sources SET status = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [sourceId, status]);
    return rows[0] || null;
  };
  const recordSourceValidationFailure = async ({ sourceId, code }) => {
    if (!uuid(sourceId) || !errorCode(code) || code === null) {
      throw invalid('PROVIDER_SOURCE_INVALID_FAILURE');
    }
    const { rows } = await db.query(`UPDATE provider_sources SET status = 'broken',
      failure_count = failure_count + 1, last_error_code = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [sourceId, code]);
    return rows[0] || null;
  };
  return Object.freeze({ upsertSource, findActiveSourcesForMapping,
    markSourceStatus, recordSourceValidationFailure });
};

module.exports = { createProviderSourceStore, normalizeSource };
