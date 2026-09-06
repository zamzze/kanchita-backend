'use strict';

const pool = require('../../config/db');
const { getSubtitle } = require('../subtitles/subtitles.service');
const { getActiveSubscription } = require('../../db/auth.queries');
const { createStreamStore } = require('../../db/streams.queries');
const { createHlsValidator } = require('./hlsValidator');
const { resolveStream } = require('./streamResolver');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
  STREAM_LOCK_TIMEOUT_MS,
} = require('../../config/env');

const unavailableError = () => {
  const error = new Error('Stream temporarily unavailable');
  error.statusCode = 503;
  error.code = 'STREAM_TEMPORARILY_UNAVAILABLE';
  error.safeToExpose = true;
  return error;
};

const notFoundError = (contentType) => {
  const error = new Error(contentType === 'movie'
    ? 'Película no encontrada'
    : 'Episodio no encontrado');
  error.statusCode = 404;
  return error;
};

const defaultFindContent = async (contentType, contentId, db = pool) => {
  if (contentType === 'movie') {
    const { rows } = await db.query(
      `SELECT id, tmdb_id, title
       FROM movies
       WHERE id = $1 AND is_published = TRUE`,
      [contentId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT e.id, e.season_number, e.episode_number, e.title,
            s.tmdb_id, s.title AS series_title
     FROM episodes e
     JOIN series s ON s.id = e.series_id
     WHERE e.id = $1
       AND e.is_published = TRUE
       AND s.is_published = TRUE`,
    [contentId]
  );
  return rows[0] || null;
};

const formatResponse = (streams, contentId, contentType, subtitleUrl = null) => ({
  content_id: contentId,
  content_type: contentType,
  show_ads: false,
  subtitle_url: subtitleUrl,
  streams: streams.map((stream) => ({
    server_name: stream.server_name,
    quality: stream.quality || 'auto',
    language: stream.language,
    stream_url: stream.stream_url || null,
    embed_url: stream.embed_url || null,
    stream_type: stream.stream_type,
    priority: stream.priority,
  })),
});

const createStreamsService = ({
  db = pool,
  resolver = resolveStream,
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
  }),
  findContent = (contentType, contentId) => defaultFindContent(contentType, contentId, db),
  subtitleFetcher = getSubtitle,
  subscriptionFetcher = (userId) => getActiveSubscription(userId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
  lockTimeoutMs = STREAM_LOCK_TIMEOUT_MS,
} = {}) => {
  const store = createStreamStore(db);
  const ttlMs = cacheTtlMinutes * 60 * 1000;
  const verifyIntervalMs = verifyIntervalMinutes * 60 * 1000;

  const fallbackExpiry = () => new Date(Date.now() + ttlMs);

  const freshReadyStreams = (streams) => {
    const now = Date.now();
    return streams.filter((stream) =>
      stream.status === 'ready' &&
      stream.stream_url &&
      stream.expires_at &&
      new Date(stream.expires_at).getTime() > now &&
      stream.last_verified_at &&
      new Date(stream.last_verified_at).getTime() > now - verifyIntervalMs
    );
  };

  const activeBackoff = (streams) => streams.length > 0 && streams.every((stream) =>
    stream.status === 'failed' &&
    stream.next_retry_at &&
    new Date(stream.next_retry_at).getTime() > Date.now()
  );

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
    const fresh = freshReadyStreams(streams);
    if (fresh.length > 0) {
      logger.log('[Streams] cache hit');
      return { streams: fresh, all: streams };
    }

    if (activeBackoff(streams)) {
      return { streams: null, all: streams, backoff: true };
    }

    if (validate) {
      for (const stream of streams) {
        if (stream.status !== 'failed') {
          const valid = await validateCandidate(stream);
          if (valid) return { streams: [valid], all: streams };
        }
      }
    }
    return { streams: null, all: streams, backoff: false };
  };

  const persistFailure = async (contentType, contentId, candidate, errorCode) => {
    await store.recordFailure({
      streamId: candidate?.id || null,
      contentType,
      contentId,
      serverName: candidate ? candidate.server_name : 'HD',
      errorCode,
    });
    throw unavailableError();
  };

  const resolveAndValidate = async (contentType, contentId, content, cached) => {
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
    } catch {
      logger.warn('[Streams] resolution failed: RESOLUTION_FAILED');
      return persistFailure(contentType, contentId, candidate, 'RESOLUTION_FAILED');
    }

    if (!resolved?.url) {
      logger.warn('[Streams] resolution failed: RESOLUTION_FAILED');
      return persistFailure(contentType, contentId, candidate, 'RESOLUTION_FAILED');
    }

    const validation = await validator(resolved.url);
    if (!validation.valid) {
      logger.warn(`[Streams] validation failed: ${validation.code}`);
      return persistFailure(contentType, contentId, candidate, validation.code);
    }

    const now = new Date();
    const explicitExpiry = resolved.expiresAt ? new Date(resolved.expiresAt) : null;
    if (explicitExpiry && (!Number.isFinite(explicitExpiry.getTime()) || explicitExpiry <= now)) {
      return persistFailure(contentType, contentId, candidate, 'RESOLUTION_FAILED');
    }

    const directStream = await store.upsertStream({
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
    return [directStream];
  };

  const getLifecycleStreams = async (contentType, contentId, content) => {
    const initial = await readUsableCache(contentType, contentId);
    if (initial.streams) return initial.streams;
    if (initial.backoff) throw unavailableError();

    const locked = await store.withContentLock(
      contentType,
      contentId,
      lockTimeoutMs,
      async () => {
        const afterLock = await readUsableCache(contentType, contentId, { validate: true });
        if (afterLock.streams) return afterLock.streams;
        if (afterLock.backoff) throw unavailableError();
        return resolveAndValidate(contentType, contentId, content, afterLock.all);
      }
    );

    if (!locked.acquired) throw unavailableError();
    return locked.value;
  };

  const fetchSubtitle = async (contentType, contentId, content) => {
    try {
      const subtitle = await subtitleFetcher(
        content.tmdb_id,
        contentType,
        contentId,
        content.season_number || null,
        content.episode_number || null
      );
      return subtitle?.subtitle_url || null;
    } catch {
      logger.warn('[Streams] subtitle unavailable');
      return null;
    }
  };

  const getStreams = async (contentType, contentId, userId) => {
    const content = await findContent(contentType, contentId);
    if (!content) throw notFoundError(contentType);

    const streams = await getLifecycleStreams(contentType, contentId, content);
    const subtitleUrl = await fetchSubtitle(contentType, contentId, content);
    if (userId) await subscriptionFetcher(userId);
    return formatResponse(streams, contentId, contentType, subtitleUrl);
  };

  return {
    getMovieStreams: (movieId, userId) => getStreams('movie', movieId, userId),
    getEpisodeStreams: (episodeId, userId) => getStreams('episode', episodeId, userId),
  };
};

module.exports = {
  ...createStreamsService(),
  createStreamsService,
  formatResponse,
};
