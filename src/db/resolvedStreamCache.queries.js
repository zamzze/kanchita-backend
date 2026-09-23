'use strict';

const { errorCode, identityHash, invalid, safeHeaders, safeHttpUrl, safeJsonObject,
  shortLabel, timestamp, uuid } = require('./bulkPersistence.validation');

const PROTOCOLS = new Set(['hls', 'mp4', 'dash']);
const STATUSES = new Set(['active', 'stale', 'broken', 'expired', 'refresh_required', 'disabled']);

const normalizeStream = (input) => {
  const sourceId = input?.sourceId;
  const protocol = input?.protocol;
  const sensitivity = input?.urlSensitivity ?? 'normal';
  const streamUrl = safeHttpUrl(input?.url, sensitivity === 'temporary_signed');
  const variantKey = input?.variantKey === undefined ? '' : input.variantKey;
  const quality = shortLabel(input?.quality, 32);
  const language = shortLabel(input?.language, 32);
  const headers = safeHeaders(input?.headers);
  const metadata = safeJsonObject(input?.metadata);
  const status = input?.status ?? 'active';
  const expiresAt = timestamp(input?.expiresAt);
  const validatedAt = timestamp(input?.validatedAt);
  if (!uuid(sourceId) || !PROTOCOLS.has(protocol) || !streamUrl ||
      typeof variantKey !== 'string' || variantKey.length > 128 ||
      quality === undefined || language === undefined || !headers || !metadata ||
      !STATUSES.has(status) || !['normal', 'temporary_signed'].includes(sensitivity) ||
      expiresAt === undefined || validatedAt === undefined ||
      (sensitivity === 'temporary_signed' && !expiresAt)) return null;
  return Object.freeze({ sourceId, protocol, streamUrl, variantKey, quality, language,
    headers, metadata, status, expiresAt, validatedAt, urlSensitivity: sensitivity,
    streamKey: identityHash(protocol, quality, language, variantKey) });
};

const createResolvedStreamStore = (db) => {
  if (!db || typeof db.query !== 'function') throw invalid('RESOLVED_STREAM_INVALID_DB');
  const upsertStream = async (input) => {
    const stream = normalizeStream(input);
    if (!stream) throw invalid('RESOLVED_STREAM_INVALID_INPUT');
    const { rows } = await db.query(`
      INSERT INTO resolved_stream_cache (source_id, stream_key, variant_key, stream_url,
        protocol, quality, language, headers_json, url_sensitivity, status,
        expires_at, validated_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (source_id, stream_key) DO UPDATE SET
        stream_url = EXCLUDED.stream_url,
        headers_json = EXCLUDED.headers_json,
        url_sensitivity = EXCLUDED.url_sensitivity,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        validated_at = EXCLUDED.validated_at,
        metadata = EXCLUDED.metadata,
        failure_count = 0,
        last_error_code = NULL,
        updated_at = NOW()
      RETURNING *`, [stream.sourceId, stream.streamKey, stream.variantKey, stream.streamUrl,
      stream.protocol, stream.quality, stream.language, JSON.stringify(stream.headers),
      stream.urlSensitivity, stream.status, stream.expiresAt, stream.validatedAt,
      JSON.stringify(stream.metadata)]);
    return rows[0];
  };
  const findUsableStreamsForSource = async (sourceId, safetySeconds = 60,
    maxValidationAgeMinutes = 30) => {
    if (!uuid(sourceId) || !Number.isInteger(safetySeconds) ||
        safetySeconds < 0 || safetySeconds > 3600 ||
        !Number.isInteger(maxValidationAgeMinutes) || maxValidationAgeMinutes < 1 ||
        maxValidationAgeMinutes > 1440) throw invalid('RESOLVED_STREAM_INVALID_LOOKUP');
    const { rows } = await db.query(`SELECT cache.* FROM resolved_stream_cache cache
      JOIN provider_sources source ON source.id = cache.source_id
      WHERE cache.source_id = $1 AND source.status = 'active' AND cache.status = 'active'
        AND cache.stream_url IS NOT NULL
        AND cache.validated_at IS NOT NULL
        AND cache.validated_at > NOW() - ($3::integer * INTERVAL '1 minute')
        AND (cache.expires_at IS NULL OR cache.expires_at > NOW() +
          ($2::integer * INTERVAL '1 second'))
      ORDER BY cache.validated_at DESC, cache.id`,
    [sourceId, safetySeconds, maxValidationAgeMinutes]);
    return rows;
  };
  const markStreamStatus = async ({ streamId, status }) => {
    if (!uuid(streamId) || !STATUSES.has(status)) throw invalid('RESOLVED_STREAM_INVALID_STATUS');
    const { rows } = await db.query(`UPDATE resolved_stream_cache SET status = $2,
      stream_url = CASE WHEN $2 <> 'active' AND url_sensitivity = 'temporary_signed'
        THEN NULL ELSE stream_url END,
      updated_at = NOW() WHERE id = $1 AND ($2 <> 'active' OR stream_url IS NOT NULL)
      RETURNING *`, [streamId, status]);
    return rows[0] || null;
  };
  const recordValidationFailure = async ({ streamId, code }) => {
    if (!uuid(streamId) || !errorCode(code) || code === null) {
      throw invalid('RESOLVED_STREAM_INVALID_FAILURE');
    }
    const { rows } = await db.query(`UPDATE resolved_stream_cache SET status = 'broken',
      stream_url = CASE WHEN url_sensitivity = 'temporary_signed'
        THEN NULL ELSE stream_url END,
      validated_at = NULL, failure_count = failure_count + 1,
      last_error_code = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [streamId, code]);
    return rows[0] || null;
  };
  return Object.freeze({ upsertStream, findUsableStreamsForSource,
    markStreamStatus, recordValidationFailure });
};

module.exports = { createResolvedStreamStore, normalizeStream };
