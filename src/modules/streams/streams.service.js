'use strict';

const pool = require('../../config/db');
const { getSubtitle } = require('../subtitles/subtitles.service');
const { getActiveSubscription } = require('../../db/auth.queries');
const { createHlsValidator } = require('./hlsValidator');
const { createResolutionQueue } = require('./resolutionQueue');
const { findStreamContent } = require('./streamContent');
const { createStreamLifecycle } = require('./streamLifecycle');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
  STREAM_JOB_MAX_ATTEMPTS,
  STREAM_PENDING_RETRY_SECONDS,
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

const pendingResponse = (retryAfterSeconds) => ({
  status: 'pending',
  code: 'STREAM_RESOLUTION_PENDING',
  retry_after_ms: retryAfterSeconds * 1000,
});

const isPendingResponse = (result) =>
  result?.status === 'pending' && result?.code === 'STREAM_RESOLUTION_PENDING';

const createStreamsService = ({
  db = pool,
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
  }),
  queue = createResolutionQueue(db, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS }),
  findContent = (contentType, contentId) => findStreamContent(contentType, contentId, db),
  subtitleFetcher = getSubtitle,
  subscriptionFetcher = (userId) => getActiveSubscription(userId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
  pendingRetrySeconds = STREAM_PENDING_RETRY_SECONDS,
} = {}) => {
  const lifecycle = createStreamLifecycle({
    db,
    validator,
    logger,
    cacheTtlMinutes,
    verifyIntervalMinutes,
  });

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
    if (userId) await subscriptionFetcher(userId);

    const cache = await lifecycle.readUsableCache(contentType, contentId, {
      validate: true,
    });
    if (cache.streams) {
      const subtitleUrl = await fetchSubtitle(contentType, contentId, content);
      return formatResponse(cache.streams, contentId, contentType, subtitleUrl);
    }
    if (cache.backoff) throw unavailableError();

    await queue.enqueue(contentType, contentId);
    logger.log('[Streams] resolution queued');
    return pendingResponse(pendingRetrySeconds);
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
  isPendingResponse,
  pendingResponse,
};
