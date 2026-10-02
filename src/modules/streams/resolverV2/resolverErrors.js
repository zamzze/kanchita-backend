'use strict';

const ENGINE_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'RESOLVER_ENGINE_INVALID_INPUT',
  INVALID_RESULT: 'RESOLVER_ENGINE_INVALID_RESULT',
  TIMEOUT: 'RESOLVER_ENGINE_TIMEOUT',
  ABORTED: 'RESOLVER_ENGINE_ABORTED',
  LEGACY_INVALID_RESULT: 'LEGACY_RESOLUTION_INVALID_RESULT',
});

const resolverEngineError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

module.exports = {
  ENGINE_ERROR_CODES,
  resolverEngineError,
};
