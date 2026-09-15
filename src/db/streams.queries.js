'use strict';

const pool = require('../config/db');
const { playbackHeadersOrNull } = require('../modules/streams/playbackHeaders');

const streamColumns = `
  id, server_name, quality, language, stream_url, embed_url,
  stream_type, priority, is_active, provider, status, expires_at,
  resolved_at, last_verified_at, failure_count, last_failure_at,
  next_retry_at, last_error_code, audio_language, subtitle_language,
  cleanliness, playback_headers, url_sensitivity`;

const createStreamStore = (db = pool) => {
  const findStreams = async (contentType, contentId) => {
    const { rows } = await db.query(
      `SELECT ${streamColumns}
       FROM streams
       WHERE content_type = $1 AND content_id = $2 AND is_active = TRUE
       ORDER BY priority ASC`,
      [contentType, contentId]
    );
    return rows;
  };

  const findDirectStreams = async (contentType, contentId) => {
    const { rows } = await db.query(
      `SELECT ${streamColumns}
       FROM streams
       WHERE content_type = $1
         AND content_id = $2
         AND stream_type = 'direct'
         AND is_active = TRUE
       ORDER BY priority ASC`,
      [contentType, contentId]
    );
    return rows;
  };

  const markVerified = async (streamId, fallbackExpiresAt, cleanliness = 'unknown') => {
    const { rows } = await db.query(
      `UPDATE streams
       SET status = 'ready',
           expires_at = COALESCE(expires_at, $2),
           last_verified_at = NOW(),
           failure_count = 0,
           last_failure_at = NULL,
           next_retry_at = NULL,
           last_error_code = NULL,
           cleanliness = $3
       WHERE id = $1
       RETURNING ${streamColumns}`,
      [streamId, fallbackExpiresAt, cleanliness]
    );
    return rows[0] || null;
  };

  const markStale = (streamId) => db.query(
    `UPDATE streams
     SET status = 'stale',
         stream_url = CASE WHEN url_sensitivity = 'temporary_signed' THEN NULL ELSE stream_url END
     WHERE id = $1 AND status <> 'failed'`,
    [streamId]
  );

  const failureDelaySql = `CASE
    WHEN streams.failure_count = 0 THEN INTERVAL '30 seconds'
    WHEN streams.failure_count = 1 THEN INTERVAL '2 minutes'
    WHEN streams.failure_count = 2 THEN INTERVAL '5 minutes'
    ELSE INTERVAL '15 minutes'
  END`;

  const recordFailure = async ({
    streamId = null,
    contentType,
    contentId,
    serverName = 'HD',
    errorCode,
  }) => {
    if (streamId) {
      const { rows } = await db.query(
        `UPDATE streams
         SET status = 'failed',
             stream_url = CASE WHEN url_sensitivity = 'temporary_signed' THEN NULL ELSE stream_url END,
             failure_count = failure_count + 1,
             last_failure_at = NOW(),
             next_retry_at = NOW() + ${failureDelaySql},
             last_error_code = $2
         WHERE id = $1
         RETURNING ${streamColumns}`,
        [streamId, errorCode]
      );
      return rows[0] || null;
    }

    const { rows } = await db.query(
      `INSERT INTO streams (
         content_type, content_id, server_name, quality, language,
         stream_url, embed_url, stream_type, priority, is_active,
         status, failure_count, last_failure_at, next_retry_at, last_error_code
       ) VALUES (
         $1, $2, $3, 'auto', 'en-sub', NULL, NULL, 'direct', 1, TRUE,
         'failed', 1, NOW(), NOW() + INTERVAL '30 seconds', $4
       )
       ON CONFLICT ON CONSTRAINT streams_content_server_unique
       DO UPDATE SET
         status = 'failed',
         failure_count = streams.failure_count + 1,
         last_failure_at = NOW(),
         next_retry_at = NOW() + ${failureDelaySql},
         last_error_code = EXCLUDED.last_error_code
       RETURNING ${streamColumns}`,
      [contentType, contentId, serverName, errorCode]
    );
    return rows[0];
  };

  const recordRefreshFailure = async (streamId, errorCode) => {
    const { rows } = await db.query(
      `UPDATE streams
       SET failure_count = failure_count + 1,
           last_failure_at = NOW(),
           next_retry_at = NOW() + ${failureDelaySql},
           last_error_code = $2
       WHERE id = $1 AND status = 'ready' AND expires_at > NOW()
       RETURNING ${streamColumns}`,
      [streamId, errorCode]
    );
    return rows[0] || null;
  };

  const upsertStreamWithClient = async (client, stream) => {
    const playbackHeaders = playbackHeadersOrNull(stream.playback_headers);
    if (stream.playback_headers != null && !playbackHeaders) {
      const error = new Error('STREAM_PLAYBACK_HEADERS_INVALID');
      error.code = 'STREAM_PLAYBACK_HEADERS_INVALID';
      throw error;
    }
    const { rows } = await client.query(
      `INSERT INTO streams (
         content_type, content_id, server_name, quality, language,
         stream_url, embed_url, stream_type, priority, is_active,
         provider, status, expires_at, resolved_at, last_verified_at,
         failure_count, last_failure_at, next_retry_at, last_error_code,
         audio_language, subtitle_language, cleanliness, playback_headers,
         url_sensitivity
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
       )
       ON CONFLICT ON CONSTRAINT streams_content_server_unique
       DO UPDATE SET
         stream_url = EXCLUDED.stream_url,
         embed_url = EXCLUDED.embed_url,
         stream_type = EXCLUDED.stream_type,
         quality = EXCLUDED.quality,
         language = EXCLUDED.language,
         priority = EXCLUDED.priority,
         is_active = TRUE,
         provider = EXCLUDED.provider,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         resolved_at = EXCLUDED.resolved_at,
         last_verified_at = EXCLUDED.last_verified_at,
         failure_count = EXCLUDED.failure_count,
         last_failure_at = EXCLUDED.last_failure_at,
         next_retry_at = EXCLUDED.next_retry_at,
         last_error_code = EXCLUDED.last_error_code,
         audio_language = EXCLUDED.audio_language,
         subtitle_language = EXCLUDED.subtitle_language,
         cleanliness = EXCLUDED.cleanliness,
         playback_headers = EXCLUDED.playback_headers,
         url_sensitivity = EXCLUDED.url_sensitivity
       RETURNING ${streamColumns}`,
      [
        stream.content_type,
        stream.content_id,
        stream.server_name,
        stream.quality,
        stream.language,
        stream.stream_url || null,
        stream.embed_url || null,
        stream.stream_type,
        stream.priority,
        stream.provider || null,
        stream.status || 'unknown',
        stream.expires_at || null,
        stream.resolved_at || null,
        stream.last_verified_at || null,
        stream.failure_count || 0,
        stream.last_failure_at || null,
        stream.next_retry_at || null,
        stream.last_error_code || null,
        stream.audio_language || null,
        stream.subtitle_language || null,
        stream.cleanliness || 'unknown',
        playbackHeaders && Object.keys(playbackHeaders).length ? playbackHeaders : null,
        stream.url_sensitivity || 'normal',
      ]
    );
    return rows[0];
  };

  const upsertStream = (stream) => upsertStreamWithClient(db, stream);

  const findProxyStream = async (streamId, temporarySafetyWindowMs = 60_000) => {
    const { rows } = await db.query(
      `SELECT ${streamColumns}
       FROM streams
       WHERE id = $1 AND is_active = TRUE AND status = 'ready'
         AND stream_url IS NOT NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (url_sensitivity = 'normal'
           OR expires_at > NOW() + ($2::double precision * INTERVAL '1 millisecond'))`,
      [streamId, temporarySafetyWindowMs]
    );
    return rows[0] || null;
  };

  return {
    findStreams,
    findDirectStreams,
    markVerified,
    markStale,
    recordFailure,
    recordRefreshFailure,
    upsertStream,
    upsertStreamWithClient,
    findProxyStream,
  };
};

const defaultStore = createStreamStore();

const findEpisodeWithSeries = async (episodeId, db = pool) => {
  const { rows } = await db.query(
    `SELECT e.id, e.series_id, e.is_published, s.is_published AS series_published
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1`,
    [episodeId]
  );
  return rows[0] || null;
};

module.exports = {
  ...defaultStore,
  createStreamStore,
  findEpisodeWithSeries,
  getStreamsByContent: defaultStore.findStreams,
};
