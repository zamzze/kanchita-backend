'use strict';

const { normalizeLanguage, normalizeQuality } = require('./streamAttributes');

const normalizeProviderStream = (raw, context = {}) => ({
  provider: raw.provider || context.provider,
  content_type: context.contentType,
  content_id: context.contentId,
  stream_url: raw.stream_url || raw.url,
  stream_type: raw.stream_type || raw.streamType || 'hls',
  quality: normalizeQuality(raw.quality),
  audio_language: normalizeLanguage(raw.audio_language || raw.audioLanguage || raw.language),
  subtitle_language: raw.subtitle_language || raw.subtitleLanguage
    ? normalizeLanguage(raw.subtitle_language || raw.subtitleLanguage)
    : null,
  cleanliness: raw.cleanliness || 'unknown',
  strategy: raw.strategy || context.strategy || 'direct',
  expires_at: raw.expires_at || raw.expiresAt || null,
  priority: Number.isInteger(raw.priority) ? raw.priority : 1,
});

module.exports = { normalizeProviderStream };
