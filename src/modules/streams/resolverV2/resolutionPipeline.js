'use strict';

const { normalizeMediaContext } = require('./resolverContracts');
const { SOURCE_PROVIDER_ERROR_CODES, sourceProviderError } = require('./sourceProviderErrors');

const emptyResolverTrace = () => ({
  attempts: [],
  usedLegacyFallback: false,
  durationMs: 0,
});

const createResolutionPipeline = ({ sourceProviderManager, resolverEngine, ranker = null } = {}) => {
  if (!sourceProviderManager || typeof sourceProviderManager.getSources !== 'function' ||
      !resolverEngine || typeof resolverEngine.resolve !== 'function' ||
      (ranker && typeof ranker.selectBest !== 'function')) {
    throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
  }

  const resolve = async (input, options = {}) => {
    const mediaContext = normalizeMediaContext(input);
    if (!mediaContext || !options || typeof options !== 'object' || Array.isArray(options)) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
    }
    const sourceResult = await sourceProviderManager.getSources(mediaContext, options);
    if (!sourceResult || !Array.isArray(sourceResult.candidates) || !sourceResult.trace) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_RESULT);
    }
    if (sourceResult.candidates.length === 0) {
      return {
        streams: [],
        selection: null,
        sourceTrace: sourceResult.trace,
        resolverTrace: emptyResolverTrace(),
      };
    }
    const resolved = await resolverEngine.resolve({
      mediaContext,
      candidates: sourceResult.candidates,
      signal: options.signal,
    });
    if (!resolved || !Array.isArray(resolved.streams)) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_RESULT);
    }
    const { streams, ...resolverTrace } = resolved;
    const selection = ranker ? ranker.selectBest(streams, { mediaContext }) : null;
    return {
      streams: selection ? selection.ranked : streams,
      selection,
      sourceTrace: sourceResult.trace,
      resolverTrace,
    };
  };

  return Object.freeze({ resolve });
};

module.exports = { createResolutionPipeline };
