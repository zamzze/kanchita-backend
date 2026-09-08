'use strict';

const {
  STREAM_PROTOCOLS,
  normalizeMediaContext,
  normalizeStreamCandidate,
} = require("./resolverContracts");
const { ENGINE_ERROR_CODES, resolverEngineError } = require('./resolverErrors');

const protocols = new Set(STREAM_PROTOCOLS);

const inferProtocol = (url, declaredProtocol) => {
  if (protocols.has(declaredProtocol)) return declaredProtocol;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) return 'hls';
    if (pathname.endsWith('.mp4')) return 'mp4';
    if (pathname.endsWith('.mpd')) return 'dash';
  } catch {
    return 'unknown';
  }
  return 'unknown';
};

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const optionalText = (value) => value === undefined || value === null || value === '' ||
  (typeof value === 'string' && value.length <= 512);

const createLegacyBrowserAdapter = ({ executeLegacy, now = Date.now } = {}) => {
  if (typeof executeLegacy !== 'function') {
    throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
  }

  const resolve = async (input, context = {}) => {
    const mediaContext = normalizeMediaContext(input);
    if (!mediaContext) throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
    if (context.signal?.aborted) throw resolverEngineError(ENGINE_ERROR_CODES.ABORTED);

    const startedAt = now();
    const legacy = await executeLegacy(mediaContext, context);
    if (context.signal?.aborted) throw resolverEngineError(ENGINE_ERROR_CODES.ABORTED);
    if (legacy === null) return [];
    if (!isPlainObject(legacy) || typeof legacy.url !== 'string' ||
        !optionalText(legacy.provider) || !optionalText(legacy.serverName) ||
        !optionalText(legacy.quality) || !optionalText(legacy.language) ||
        !optionalText(legacy.protocol)) {
      throw resolverEngineError(ENGINE_ERROR_CODES.LEGACY_INVALID_RESULT);
    }

    const metadata = {
      ...(legacy.language ? { legacyLanguage: legacy.language } : {}),
      ...(legacy.serverName ? { legacyServerName: legacy.serverName } : {}),
    };
    const stream = normalizeStreamCandidate({
      url: legacy.url,
      protocol: inferProtocol(legacy.url, legacy.protocol),
      providerId: legacy.provider || 'legacy',
      resolverId: 'legacy_browser',
      headers: {},
      expiresAt: legacy.expiresAt ?? null,
      latencyMs: Math.max(0, now() - startedAt),
      validated: false,
      quality: legacy.quality || null,
      audioLanguage: null,
      subtitleLanguage: null,
      hlsInfo: null,
      metadata,
    });
    if (!stream) throw resolverEngineError(ENGINE_ERROR_CODES.LEGACY_INVALID_RESULT);
    return [stream];
  };

  return Object.freeze({ resolve });
};

module.exports = {
  createLegacyBrowserAdapter,
  inferProtocol,
};
