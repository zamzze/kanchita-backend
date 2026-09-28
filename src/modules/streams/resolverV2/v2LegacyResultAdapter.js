'use strict';

const { normalizeStreamCandidate } = require('./resolverContracts');
const { normalizeLanguage, normalizeQuality } = require('../streamAttributes');
const { playbackHeadersOrNull } = require('../playbackHeaders');

const ADAPTER_ERROR_CODE = 'V2_LEGACY_ADAPTER_INVALID_INPUT';
const adapterError = () => Object.assign(new Error(ADAPTER_ERROR_CODE), {
  code: ADAPTER_ERROR_CODE,
});

const adaptV2ToLegacyResult = (candidate) => {
  const stream = normalizeStreamCandidate(candidate);
  const playbackHeaders = stream ? playbackHeadersOrNull(stream.headers) : null;
  if (!stream || !playbackHeaders || stream.validated !== true ||
      !['hls', 'mp4'].includes(stream.protocol) ||
      (stream.protocol === 'mp4' && Object.keys(playbackHeaders).length > 0) ||
      !['direct', 'http'].includes(stream.metadata?.resolverStrategy)) {
    throw adapterError();
  }
  const audioLanguage = normalizeLanguage(stream.audioLanguage);
  const subtitleLanguage = normalizeLanguage(stream.subtitleLanguage);
  const language = audioLanguage === 'en' && subtitleLanguage.startsWith('es')
    ? 'en-sub' : audioLanguage === 'unknown' ? 'en-sub' : audioLanguage;
  return Object.freeze({
    url: stream.url,
    provider: stream.providerId,
    serverName: 'V2',
    strategy: 'direct',
    cleanliness: 'unknown',
    quality: normalizeQuality(stream.quality),
    language,
    audioLanguage: audioLanguage === 'unknown' ? null : audioLanguage,
    subtitleLanguage: subtitleLanguage === 'unknown' ? null : subtitleLanguage,
    expiresAt: stream.expiresAt,
    ...(stream.urlSensitivity === 'temporary_signed'
      ? { urlSensitivity: 'temporary_signed' } : {}),
    validated: true,
    ...(stream.protocol === 'mp4' ? { streamType: 'mp4' } : {}),
    playbackHeaders,
  });
};

module.exports = { ADAPTER_ERROR_CODE, adaptV2ToLegacyResult };
