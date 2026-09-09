'use strict';

const {
  normalizeMediaContext,
  normalizeEmbedCandidate,
  normalizeStreamCandidate,
} = require('./resolverContracts');
const { ENGINE_ERROR_CODES, resolverEngineError } = require('./resolverErrors');

const safeErrorCode = (error) =>
  typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'RESOLVER_FAILURE';

const createResolverEngine = ({
  registry,
  legacyFallback = null,
  timeoutMs = 10_000,
  maxStreams = 8,
  healthStore = null,
  observability = null,
  now = Date.now,
} = {}) => {
  if (!registry || typeof registry.detect !== 'function' ||
      (legacyFallback && typeof legacyFallback.resolve !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 100 ||
      (healthStore && (typeof healthStore.canAttempt !== 'function' ||
        typeof healthStore.recordSuccess !== 'function' ||
        typeof healthStore.recordFailure !== 'function')) ||
      (observability && typeof observability.observe !== 'function')) {
    throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
  }

  const healthCall = (method, ...args) => {
    try { return healthStore?.[method]?.(...args); } catch { return method === 'canAttempt'; }
  };
  const observe = (resolver, durationMs) => {
    const series = resolver.descriptor.strategy === 'http' ? 'resolver_http'
      : resolver.descriptor.strategy === 'direct' ? 'resolver_direct' : null;
    try { if (series) observability?.observe(series, durationMs); } catch { /* best effort */ }
  };
  const resolve = async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
    }
    const mediaContext = normalizeMediaContext(input.mediaContext);
    if (!mediaContext || !Array.isArray(input.candidates)) {
      throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
    }
    const candidates = input.candidates.map(normalizeEmbedCandidate);
    if (candidates.some((candidate) => candidate === null)) {
      throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
    }
    const externalSignal = input.signal || null;
    if (externalSignal && (typeof externalSignal.aborted !== 'boolean' ||
        typeof externalSignal.addEventListener !== 'function')) {
      throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_INPUT);
    }

    const startedAt = now();
    const deadlineAt = startedAt + timeoutMs;
    const controller = new AbortController();
    let deadlineExpired = false;
    let externallyAborted = externalSignal?.aborted === true;
    const abortFromExternal = () => {
      externallyAborted = true;
      controller.abort(resolverEngineError(ENGINE_ERROR_CODES.ABORTED));
    };
    if (externalSignal && !externallyAborted) {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(resolverEngineError(ENGINE_ERROR_CODES.TIMEOUT));
    }, timeoutMs);
    deadlineTimer.unref?.();

    const remainingMs = () => Math.max(0, deadlineAt - now());
    const throwIfStopped = () => {
      if (externallyAborted || externalSignal?.aborted) {
        throw resolverEngineError(ENGINE_ERROR_CODES.ABORTED);
      }
      if (deadlineExpired || remainingMs() === 0) {
        throw resolverEngineError(ENGINE_ERROR_CODES.TIMEOUT);
      }
    };
    const context = Object.freeze({
      signal: controller.signal,
      deadlineAt,
      remainingMs,
    });
    const streams = [];
    const attempts = [];
    let usedLegacyFallback = false;

    const addAttempt = (providerId, resolverId, outcome, attemptStartedAt, errorCode) => {
      attempts.push({
        providerId,
        resolverId,
        outcome,
        durationMs: Math.max(0, now() - attemptStartedAt),
        ...(errorCode ? { errorCode } : {}),
      });
    };
    const acceptResults = (result, resolver = null) => {
      if (!Array.isArray(result)) {
        throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
      }
      const normalized = result.map(normalizeStreamCandidate);
      if (normalized.some((candidate) => candidate === null)) {
        throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
      }
      const enriched = resolver ? normalized.map((candidate) => normalizeStreamCandidate({
        ...candidate,
        metadata: {
          ...(candidate.metadata || {}),
          resolverPriority: resolver.descriptor.priority,
          resolverStrategy: resolver.descriptor.strategy,
        },
      })) : normalized;
      streams.push(...enriched.slice(0, maxStreams - streams.length));
      return enriched.length;
    };

    try {
      throwIfStopped();
      for (const candidate of candidates) {
        throwIfStopped();
        const resolvers = registry.detect(candidate);
        if (!Array.isArray(resolvers)) {
          throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
        }
        if (resolvers.length === 0) {
          addAttempt(candidate.providerId, null, 'not_applicable', now());
          continue;
        }

        for (const resolver of resolvers) {
          throwIfStopped();
          const resolverId = resolver?.descriptor?.id || null;
          if (!resolverId || typeof resolver.resolve !== 'function') {
            throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
          }
          if (healthStore && healthCall('canAttempt', 'resolver', resolverId) === false) {
            addAttempt(candidate.providerId, resolverId, 'circuit_open', now());
            continue;
          }
          const attemptStartedAt = now();
          let completed = false;
          try {
            const result = await resolver.resolve(candidate, context);
            throwIfStopped();
            const count = acceptResults(result, resolver);
            const durationMs = Math.max(0, now() - attemptStartedAt);
            healthCall('recordSuccess', 'resolver', resolverId, { durationMs });
            observe(resolver, durationMs);
            completed = true;
            addAttempt(candidate.providerId, resolverId, count ? 'resolved' : 'empty',
              attemptStartedAt);
          } catch (error) {
            throwIfStopped();
            if (error?.code === 'INVALID_RESOLVER_RESULT' ||
                error?.code === ENGINE_ERROR_CODES.INVALID_RESULT) {
              throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
            }
            const durationMs = Math.max(0, now() - attemptStartedAt);
            healthCall('recordFailure', 'resolver', resolverId, {
              durationMs, errorCode: safeErrorCode(error),
              timeout: error?.code === 'HTTP_TIMEOUT',
            });
            observe(resolver, durationMs);
            completed = true;
            addAttempt(candidate.providerId, resolverId, 'failed', attemptStartedAt,
              safeErrorCode(error));
          } finally {
            if (!completed) healthCall('cancelAttempt', 'resolver', resolverId);
          }
          if (streams.length >= maxStreams) break;
        }
        if (streams.length >= maxStreams) break;
      }

      throwIfStopped();
      if (streams.length === 0 && legacyFallback) {
        usedLegacyFallback = true;
        const attemptStartedAt = now();
        try {
          const result = await legacyFallback.resolve(mediaContext, context);
          throwIfStopped();
          const count = acceptResults(result);
          addAttempt(count ? streams[0].providerId : 'legacy', 'legacy_browser',
            count ? 'resolved' : 'empty', attemptStartedAt);
        } catch (error) {
          throwIfStopped();
          if (error?.code === 'INVALID_RESOLVER_RESULT' ||
              error?.code === ENGINE_ERROR_CODES.INVALID_RESULT) {
            throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
          }
          addAttempt('legacy', 'legacy_browser', 'failed', attemptStartedAt,
            safeErrorCode(error));
        }
      }

      throwIfStopped();
      return {
        streams,
        attempts,
        usedLegacyFallback,
        durationMs: Math.max(0, now() - startedAt),
      };
    } finally {
      clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  };

  return Object.freeze({ resolve });
};

module.exports = {
  createResolverEngine,
};
