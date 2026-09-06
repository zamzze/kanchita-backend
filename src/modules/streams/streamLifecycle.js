'use strict';

const { createStreamStore } = require('../../db/streams.queries');

const processingError = (code) => {
  const error = new Error('Stream processing failed');
  error.code = code;
  return error;
};

const isFreshReadyStream = (stream, verifyIntervalMs, now = Date.now()) =>
  stream.status === 'ready' &&
  Boolean(stream.stream_url) &&
  Boolean(stream.expires_at) &&
  new Date(stream.expires_at).getTime() > now &&
  Boolean(stream.last_verified_at) &&
  new Date(stream.last_verified_at).getTime() > now - verifyIntervalMs;

const hasActiveBackoff = (streams, now = Date.now()) => streams.length > 0 &&
  streams.every((stream) =>
    stream.status === 'failed' &&
    stream.next_retry_at &&
    new Date(stream.next_retry_at).getTime() > now
  );

const createStreamLifecycle = ({
  db,
  validator,
  logger = console,
  cacheTtlMinutes,
  verifyIntervalMinutes,
} = {}) => {
  const store = createStreamStore(db);
  const ttlMs = cacheTtlMinutes * 60 * 1000;
  const verifyIntervalMs = verifyIntervalMinutes * 60 * 1000;
  const fallbackExpiry = () => new Date(Date.now() + ttlMs);

  const validateCandidate = async (stream) => {
    if (!stream.stream_url) return null;
    if (stream.expires_at && new Date(stream.expires_at).getTime() <= Date.now()) {
      logger.log('[Streams] cache expired');
      await store.markStale(stream.id);
      return null;
    }

    const validation = await validator(stream.stream_url);
    if (!validation.valid) {
      logger.warn(`[Streams] validation failed: ${validation.code}`);
      await store.markStale(stream.id);
      return null;
    }

    logger.log('[Streams] cache validated');
    return store.markVerified(stream.id, fallbackExpiry());
  };

  const readUsableCache = async (contentType, contentId, { validate = false } = {}) => {
    const streams = await store.findDirectStreams(contentType, contentId);
    const fresh = streams.filter((stream) =>
      isFreshReadyStream(stream, verifyIntervalMs)
    );
    if (fresh.length > 0) {
      logger.log('[Streams] cache hit');
      return { streams: fresh, all: streams, backoff: false };
    }

    if (hasActiveBackoff(streams)) {
      return { streams: null, all: streams, backoff: true };
    }

    if (validate) {
      for (const stream of streams) {
        if (stream.status !== 'failed') {
          const valid = await validateCandidate(stream);
          if (valid) return { streams: [valid], all: streams, backoff: false };
        }
      }
    }
    return { streams: null, all: streams, backoff: false };
  };

  const recordFailure = async (
    contentType,
    contentId,
    candidate,
    errorCode
  ) => {
    await store.recordFailure({
      streamId: candidate?.id || null,
      contentType,
      contentId,
      serverName: candidate ? candidate.server_name : 'HD',
      errorCode,
    });
    throw processingError(errorCode);
  };

  const resolveAndPersist = async (contentType, contentId, content, resolver) => {
    const cached = await store.findDirectStreams(contentType, contentId);
    const candidate = cached.find((stream) => stream.stream_url) || cached[0] || null;
    if (candidate) await store.markStale(candidate.id);
    logger.log('[Streams] resolving content');

    let resolved;
    try {
      resolved = await resolver({
        contentType,
        contentId,
        tmdbId: content.tmdb_id,
        title: content.title || content.series_title,
        season: content.season_number,
        episode: content.episode_number,
      });
    } catch (error) {
      const code = error?.code === 'RESOLUTION_TIMEOUT'
        ? 'RESOLUTION_TIMEOUT'
        : 'RESOLUTION_FAILED';
      logger.warn(`[Streams] resolution failed: ${code}`);
      return recordFailure(contentType, contentId, candidate, code);
    }

    if (!resolved?.url) {
      logger.warn('[Streams] resolution failed: RESOLUTION_FAILED');
      return recordFailure(contentType, contentId, candidate, 'RESOLUTION_FAILED');
    }

    const validation = await validator(resolved.url);
    if (!validation.valid) {
      logger.warn(`[Streams] validation failed: ${validation.code}`);
      return recordFailure(contentType, contentId, candidate, validation.code);
    }

    const now = new Date();
    const explicitExpiry = resolved.expiresAt ? new Date(resolved.expiresAt) : null;
    if (explicitExpiry && (!Number.isFinite(explicitExpiry.getTime()) || explicitExpiry <= now)) {
      return recordFailure(contentType, contentId, candidate, 'RESOLUTION_FAILED');
    }

    return store.upsertStream({
      content_type: contentType,
      content_id: contentId,
      server_name: candidate ? candidate.server_name : (resolved.serverName || 'HD'),
      quality: resolved.quality || 'auto',
      language: resolved.language || 'en-sub',
      stream_url: resolved.url,
      embed_url: null,
      stream_type: 'direct',
      priority: 1,
      provider: resolved.provider || null,
      status: 'ready',
      expires_at: explicitExpiry || fallbackExpiry(),
      resolved_at: now,
      last_verified_at: now,
      failure_count: 0,
      last_failure_at: null,
      next_retry_at: null,
      last_error_code: null,
    });
  };

  return { readUsableCache, resolveAndPersist };
};

module.exports = {
  createStreamLifecycle,
  hasActiveBackoff,
  isFreshReadyStream,
  processingError,
};
