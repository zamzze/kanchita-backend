'use strict';

const pool = require('../../config/db');
const { getSubtitle } = require('../subtitles/subtitles.service');
const { getActiveSubscription } = require('../../db/auth.queries');
const { createHlsValidator } = require('./hlsValidator');
const { createResolutionQueue } = require('./resolutionQueue');
const { findStreamContent } = require('./streamContent');
const { createStreamLifecycle } = require('./streamLifecycle');
const { createStreamStatsStore } = require('./streamStats');
const { createMetricsStore } = require('./streamMetrics');
const { createStreamPrewarm } = require('./streamPrewarm');
const {
  STREAM_CACHE_TTL_MINUTES,
  STREAM_VERIFY_INTERVAL_MINUTES,
  STREAM_VERIFY_TIMEOUT_MS,
  STREAM_MAX_MANIFEST_BYTES,
  STREAM_JOB_MAX_ATTEMPTS,
  STREAM_PENDING_RETRY_SECONDS,
  STREAM_REFRESH_AHEAD_MINUTES,
  STREAM_PREWARM_NEXT_EPISODE,
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
  error.code = 'STREAM_NOT_AVAILABLE';
  return error;
};

const formatResponse = (streams, contentId, contentType, subtitleUrl = null) => {
  const serialized = streams.map((stream) => ({
    server_name: stream.server_name,
    quality: stream.quality || 'auto',
    language: stream.language,
    audio_language: stream.audio_language || null,
    subtitle_language: stream.subtitle_language || null,
    stream_url: stream.stream_url || null,
    embed_url: stream.embed_url || null,
    stream_type: stream.stream_type,
    priority: stream.priority,
    expires_at: stream.expires_at || null,
  }));
  const primary = serialized[0] || null;
  return {
  status: 'ready',
  content_id: contentId,
  content_type: contentType,
  show_ads: false,
  subtitle_url: subtitleUrl,
  stream: primary ? {
    url: primary.stream_url,
    type: primary.stream_type === 'direct' ? 'hls' : primary.stream_type,
    quality: primary.quality,
    audio_language: primary.audio_language,
    subtitle_language: primary.subtitle_language,
    expires_at: primary.expires_at,
  } : null,
  subtitles: subtitleUrl ? [{
    url: subtitleUrl,
    language: primary?.subtitle_language || 'es',
  }] : [],
  streams: serialized,
  };
};

const pendingResponse = (retryAfterSeconds) => ({
  status: 'pending',
  code: 'STREAM_RESOLUTION_PENDING',
  retry_after_ms: retryAfterSeconds * 1000,
});

const isPendingResponse = (result) =>
  result?.status === 'pending' && [
    'STREAM_RESOLUTION_PENDING',
    'STREAM_PREPARING',
  ].includes(result?.code);

const createStreamsService = ({
  db = pool,
  validator = createHlsValidator({
    timeoutMs: STREAM_VERIFY_TIMEOUT_MS,
    maxBytes: STREAM_MAX_MANIFEST_BYTES,
    includeManifest: true,
  }),
  queue = createResolutionQueue(db, { maxAttempts: STREAM_JOB_MAX_ATTEMPTS }),
  findContent = (contentType, contentId) => findStreamContent(contentType, contentId, db),
  subtitleFetcher = getSubtitle,
  subscriptionFetcher = (userId) => getActiveSubscription(userId, db),
  logger = console,
  cacheTtlMinutes = STREAM_CACHE_TTL_MINUTES,
  verifyIntervalMinutes = STREAM_VERIFY_INTERVAL_MINUTES,
  pendingRetrySeconds = STREAM_PENDING_RETRY_SECONDS,
  refreshAheadMinutes = STREAM_REFRESH_AHEAD_MINUTES,
  prewarmNextEpisode = STREAM_PREWARM_NEXT_EPISODE,
  metrics = createMetricsStore(db),
  stats = createStreamStatsStore(db),
} = {}) => {
  const lifecycle = createStreamLifecycle({
    db,
    validator,
    logger,
    cacheTtlMinutes,
    verifyIntervalMinutes,
  });
  const prewarm = createStreamPrewarm({
    db,
    queue,
    lifecycle,
    refreshAheadMinutes,
  });

  const maybeRefresh = async (contentType, contentId, streams) => {
    const refreshBefore = Date.now() + refreshAheadMinutes * 60 * 1000;
    const shouldRefresh = streams.some((stream) =>
      stream.expires_at &&
      new Date(stream.expires_at).getTime() <= refreshBefore &&
      (!stream.next_retry_at || new Date(stream.next_retry_at).getTime() <= Date.now())
    );
    if (shouldRefresh) {
      await queue.enqueue(contentType, contentId, { priority: 50, jobType: 'refresh' });
    }
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
    if (userId) await subscriptionFetcher(userId);
    await stats.recordRequest(contentType, contentId);
    await metrics.increment('stream_requests_total');

    const cache = await lifecycle.readUsableCache(contentType, contentId, {
      validate: true,
    });
    if (cache.streams) {
      await metrics.increment('cache_hit_total');
      await metrics.increment('stream_ready_first_request_total');
      await maybeRefresh(contentType, contentId, cache.streams);
      if (contentType === 'episode' && prewarmNextEpisode) {
        await prewarm.prepareNextEpisode(contentId);
      }
      const subtitleUrl = await fetchSubtitle(contentType, contentId, content);
      return formatResponse(cache.streams, contentId, contentType, subtitleUrl);
    }
    await metrics.increment('cache_miss_total');
    if (cache.backoff) {
      await metrics.increment('stream_unavailable_total');
      throw unavailableError();
    }

    await queue.enqueue(contentType, contentId, { priority: 50 });
    await metrics.increment('stream_pending_total');
    logger.log('[Streams] resolution queued');
    return pendingResponse(pendingRetrySeconds);
  };

  const prepare = async (contentType, contentId) => {
    const content = await findContent(contentType, contentId);
    if (!content) throw notFoundError(contentType);
    await metrics.increment('prewarm_requested_total');
    const cache = await lifecycle.readUsableCache(contentType, contentId);
    if (cache.streams) {
      await metrics.increment('prewarm_hit_total');
      await maybeRefresh(contentType, contentId, cache.streams);
      return { status: 'ready', code: 'STREAM_ALREADY_READY' };
    }
    if (cache.backoff) throw unavailableError();
    await queue.enqueue(contentType, contentId, { priority: 100 });
    return {
      status: 'pending',
      code: 'STREAM_PREPARING',
      retry_after_ms: pendingRetrySeconds * 1000,
    };
  };

  return {
    getMovieStreams: (movieId, userId) => getStreams('movie', movieId, userId),
    getEpisodeStreams: (episodeId, userId) => getStreams('episode', episodeId, userId),
    prepareMovie: (movieId) => prepare('movie', movieId),
    prepareEpisode: (episodeId) => prepare('episode', episodeId),
  };
};

module.exports = {
  ...createStreamsService(),
  createStreamsService,
  formatResponse,
  isPendingResponse,
  pendingResponse,
};
