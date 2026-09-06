'use strict';

const MAX_URL_LENGTH = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_CODES = new Set(['RESOLUTION_FAILED']);

const isOptionalPositiveInteger = (value) =>
  value === null || value === undefined || (Number.isInteger(value) && value > 0);

const validateResolveRequest = (message) => {
  if (!message || message.type !== 'RESOLVE' || typeof message.payload !== 'object') {
    return null;
  }
  const payload = message.payload;
  if (!['movie', 'episode'].includes(payload.contentType)) return null;
  if (typeof payload.contentId !== 'string' || !UUID_PATTERN.test(payload.contentId)) return null;
  if (!Number.isInteger(payload.tmdbId) || payload.tmdbId < 1) return null;
  if (typeof payload.title !== 'string' || payload.title.length > 500) return null;
  if (!isOptionalPositiveInteger(payload.season)) return null;
  if (!isOptionalPositiveInteger(payload.episode)) return null;
  if (payload.contentType === 'episode' && (!payload.season || !payload.episode)) return null;

  return {
    contentType: payload.contentType,
    contentId: payload.contentId,
    tmdbId: payload.tmdbId,
    title: payload.title,
    season: payload.season ?? null,
    episode: payload.episode ?? null,
  };
};

const validateResolverResult = (result) => {
  if (!result || typeof result !== 'object' || typeof result.url !== 'string') return null;
  if (result.url.length < 1 || result.url.length > MAX_URL_LENGTH) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(result.url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;

  const optionalString = (value, max) =>
    value === undefined || value === null || (typeof value === 'string' && value.length <= max);
  if (!optionalString(result.provider, 100)) return null;
  if (!optionalString(result.serverName, 100)) return null;
  if (!optionalString(result.quality, 50)) return null;
  if (!optionalString(result.language, 20)) return null;
  if (result.expiresAt !== undefined && result.expiresAt !== null) {
    const expiry = new Date(result.expiresAt);
    if (!Number.isFinite(expiry.getTime())) return null;
  }

  return {
    url: result.url,
    provider: result.provider ?? null,
    serverName: result.serverName ?? null,
    quality: result.quality ?? null,
    language: result.language ?? null,
    expiresAt: result.expiresAt ?? null,
  };
};

const validateResolverResponse = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'SUCCESS') {
    const result = validateResolverResult(message.result);
    return result ? { type: 'SUCCESS', result } : null;
  }
  if (message.type === 'FAILURE' && FAILURE_CODES.has(message.code)) {
    return { type: 'FAILURE', code: message.code };
  }
  return null;
};

module.exports = {
  FAILURE_CODES,
  MAX_URL_LENGTH,
  validateResolveRequest,
  validateResolverResponse,
  validateResolverResult,
};
