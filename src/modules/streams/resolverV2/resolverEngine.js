'use strict';

const {
  normalizeMediaContext,
  normalizeEmbedCandidate,
  normalizeStreamCandidate,
} = require('./resolverContracts');
const { candidateIdentity, normalizedUrlIdentity } = require('./candidateIdentity');
const { normalizeResolverNodeResult } = require('./resolverNodeResult');
const { ENGINE_ERROR_CODES, resolverEngineError } = require('./resolverErrors');

const MAX_DEPTH_HARD = 4;
const MAX_RESOLUTION_NODES_HARD = 64;

const safeErrorCode = (error) =>
  typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'RESOLVER_FAILURE';

const streamIdentity = (stream) => JSON.stringify([
  stream.providerId,
  normalizedUrlIdentity(stream.url),
  Object.entries(stream.headers || {}).sort(([left], [right]) => left.localeCompare(right)),
]);
const graphCandidateIdentity = (candidate) => candidateIdentity({
  ...candidate,
  referer: null,
  origin: null,
  headers: Object.fromEntries(Object.entries(candidate.headers || {})
    .filter(([name]) => !['referer', 'origin'].includes(name.toLowerCase()))),
});

const createResolverEngine = ({
  registry,
  legacyFallback = null,
  timeoutMs = 10_000,
  maxStreams = 8,
  maxDepth = 0,
  maxResolutionNodes = 16,
  healthStore = null,
  observability = null,
  now = Date.now,
} = {}) => {
  if (!registry || typeof registry.detect !== 'function' ||
      (legacyFallback && typeof legacyFallback.resolve !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 100 ||
      !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DEPTH_HARD ||
      !Number.isInteger(maxResolutionNodes) || maxResolutionNodes < 1 ||
      maxResolutionNodes > MAX_RESOLUTION_NODES_HARD ||
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
    const context = Object.freeze({ signal: controller.signal, deadlineAt, remainingMs });
    const streams = [];
    const streamIdentities = new Set();
    const attempts = [];
    const queue = [];
    const visited = new Set();
    let usedLegacyFallback = false;
    let nodesQueued = 0;
    let nodesProcessed = 0;
    let nodesSkippedVisited = 0;
    let nodesSkippedDepth = 0;
    let nodesSkippedNoResolver = 0;
    let nestedCandidatesProduced = 0;
    let maxDepthReached = 0;
    let nodeLimitReached = false;

    const enqueue = (candidate, depth) => {
      if (depth > maxDepth) { nodesSkippedDepth += 1; return false; }
      let identity;
      try { identity = graphCandidateIdentity(candidate); } catch { return false; }
      if (visited.has(identity)) { nodesSkippedVisited += 1; return false; }
      if (nodesQueued >= maxResolutionNodes) { nodeLimitReached = true; return false; }
      visited.add(identity);
      queue.push({ candidate, depth });
      nodesQueued += 1;
      return true;
    };
    for (const candidate of candidates) enqueue(candidate, 0);

    const addAttempt = (providerId, resolverId, outcome, attemptStartedAt, errorCode) => {
      attempts.push({ providerId, resolverId, outcome,
        durationMs: Math.max(0, now() - attemptStartedAt),
        ...(errorCode ? { errorCode } : {}) });
    };
    const acceptStreams = (result, resolver = null) => {
      const normalized = result.map(normalizeStreamCandidate).filter(Boolean);
      const enriched = resolver ? normalized.map((candidate) => normalizeStreamCandidate({
        ...candidate,
        metadata: { ...(candidate.metadata || {}),
          resolverPriority: resolver.descriptor.priority,
          resolverStrategy: resolver.descriptor.strategy },
      })).filter(Boolean) : normalized;
      let accepted = 0;
      for (const stream of enriched) {
        const identity = streamIdentity(stream);
        if (streamIdentities.has(identity)) continue;
        streamIdentities.add(identity);
        streams.push(stream);
        accepted += 1;
        if (streams.length >= maxStreams) break;
      }
      return accepted;
    };

    try {
      throwIfStopped();
      while (queue.length > 0 && streams.length < maxStreams) {
        throwIfStopped();
        const { candidate, depth } = queue.shift();
        nodesProcessed += 1;
        maxDepthReached = Math.max(maxDepthReached, depth);
        const resolvers = registry.detect(candidate);
        if (!Array.isArray(resolvers)) {
          throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
        }
        if (resolvers.length === 0) {
          nodesSkippedNoResolver += 1;
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
            const raw = typeof resolver.resolveNode === 'function'
              ? await resolver.resolveNode(candidate, context)
              : await resolver.resolve(candidate, context);
            throwIfStopped();
            const nodeResult = normalizeResolverNodeResult(raw);
            if (!nodeResult) throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
            const streamCount = acceptStreams(nodeResult.streams, resolver);
            nestedCandidatesProduced += nodeResult.nextCandidates.length;
            if (streams.length < maxStreams) {
              for (const nextCandidate of nodeResult.nextCandidates) {
                enqueue(nextCandidate, depth + 1);
              }
            }
            const durationMs = Math.max(0, now() - attemptStartedAt);
            healthCall('recordSuccess', 'resolver', resolverId, { durationMs });
            observe(resolver, durationMs);
            completed = true;
            addAttempt(candidate.providerId, resolverId,
              streamCount || nodeResult.nextCandidates.length ? 'resolved' : 'empty',
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
      }

      throwIfStopped();
      if (streams.length === 0 && legacyFallback) {
        usedLegacyFallback = true;
        const attemptStartedAt = now();
        try {
          const result = await legacyFallback.resolve(mediaContext, context);
          throwIfStopped();
          if (!Array.isArray(result) || result.some((entry) => !normalizeStreamCandidate(entry))) {
            throw resolverEngineError(ENGINE_ERROR_CODES.INVALID_RESULT);
          }
          const count = acceptStreams(result);
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
      return { streams, attempts, usedLegacyFallback,
        durationMs: Math.max(0, now() - startedAt), nodesQueued, nodesProcessed,
        nodesSkippedVisited, nodesSkippedDepth, nodesSkippedNoResolver,
        nestedCandidatesProduced, maxDepthReached, nodeLimitReached };
    } finally {
      clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  };

  return Object.freeze({ resolve });
};

module.exports = {
  MAX_DEPTH_HARD,
  MAX_RESOLUTION_NODES_HARD,
  createResolverEngine,
};
