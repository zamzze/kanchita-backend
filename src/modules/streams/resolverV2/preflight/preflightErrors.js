'use strict';

const PREFLIGHT_CODES = Object.freeze({
  INVALID_INPUT: 'PREFLIGHT_INVALID_INPUT',
  INVALID_CONTEXT: 'PREFLIGHT_INVALID_CONTEXT',
  NO_SOURCES: 'PREFLIGHT_NO_SOURCES',
  NO_CANDIDATES: 'PREFLIGHT_NO_CANDIDATES',
  NO_STREAMS: 'PREFLIGHT_NO_STREAMS',
  REJECTED: 'PREFLIGHT_REJECTED',
  TIMEOUT: 'PREFLIGHT_TIMEOUT',
  ABORTED: 'PREFLIGHT_ABORTED',
  RUNTIME_FAILED: 'PREFLIGHT_RUNTIME_FAILED',
  CATALOG_FAILED: 'PREFLIGHT_CATALOG_FAILED',
});

const preflightError = (code) => Object.assign(new Error(code), { code });

const sanitizePreflightError = (error) => {
  const code = error?.code;
  if (code === 'SOURCE_PROVIDER_GLOBAL_TIMEOUT' || code === 'RESOLVER_ENGINE_TIMEOUT' ||
      code === PREFLIGHT_CODES.TIMEOUT) return Object.freeze({ code: PREFLIGHT_CODES.TIMEOUT });
  if (code === 'SOURCE_PROVIDER_ABORTED' || code === 'RESOLVER_ENGINE_ABORTED' ||
      code === PREFLIGHT_CODES.ABORTED) return Object.freeze({ code: PREFLIGHT_CODES.ABORTED });
  if (code === PREFLIGHT_CODES.INVALID_INPUT || code === PREFLIGHT_CODES.INVALID_CONTEXT) {
    return Object.freeze({ code });
  }
  if (code === PREFLIGHT_CODES.CATALOG_FAILED) return Object.freeze({ code });
  return Object.freeze({ code: PREFLIGHT_CODES.RUNTIME_FAILED });
};

module.exports = { PREFLIGHT_CODES, preflightError, sanitizePreflightError };
