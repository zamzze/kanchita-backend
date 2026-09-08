'use strict';

const { normalizeMediaContext, normalizeEmbedCandidate } = require('./resolverContracts');
const { candidateIdentity } = require('./candidateIdentity');
const { SOURCE_PROVIDER_ERROR_CODES, sourceProviderError } = require('./sourceProviderErrors');

const MAX_CONCURRENCY = 16;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TOTAL_CANDIDATES = 200;

const validPositiveInteger = (value, maximum) =>
  Number.isInteger(value) && value >= 1 && value <= maximum;

const createSourceProviderManager = ({
  registry,
  http = null,
  concurrency = 3,
  providerTimeoutMs = 5_000,
  globalTimeoutMs = 10_000,
  maxCandidates = 32,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!registry || typeof registry.list !== 'function' ||
      typeof registry.listForMedia !== 'function' ||
      !validPositiveInteger(concurrency, MAX_CONCURRENCY) ||
      !validPositiveInteger(providerTimeoutMs, MAX_TIMEOUT_MS) ||
      !validPositiveInteger(globalTimeoutMs, MAX_TIMEOUT_MS) ||
      !validPositiveInteger(maxCandidates, MAX_TOTAL_CANDIDATES) ||
      typeof now !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function') {
    throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
  }

  const getSources = async (input, options = {}) => {
    const mediaContext = normalizeMediaContext(input);
    if (!mediaContext || !options || typeof options !== 'object' || Array.isArray(options)) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
    }
    const externalSignal = options.signal || null;
    if (externalSignal && (typeof externalSignal.aborted !== 'boolean' ||
        typeof externalSignal.addEventListener !== 'function')) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
    }
    const resultLimit = options.maxCandidates === undefined
      ? maxCandidates : options.maxCandidates;
    if (!validPositiveInteger(resultLimit, MAX_TOTAL_CANDIDATES) ||
        (options.deadlineAt !== undefined &&
          (!Number.isFinite(options.deadlineAt) || options.deadlineAt < 0))) {
      throw sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.INVALID_INPUT);
    }

    const startedAt = now();
    const deadlineAt = Math.min(
      startedAt + globalTimeoutMs,
      options.deadlineAt === undefined ? Infinity : options.deadlineAt
    );
    let externallyAborted = externalSignal?.aborted === true;
    let deadlineExpired = deadlineAt <= startedAt;
    const controller = new AbortController();
    const abortFromExternal = () => {
      externallyAborted = true;
      controller.abort(sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.ABORTED));
    };
    if (externalSignal && !externallyAborted) {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    const deadlineDelay = Math.max(0, deadlineAt - startedAt);
    const deadlineTimer = setTimer(() => {
      deadlineExpired = true;
      controller.abort(sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.GLOBAL_TIMEOUT));
    }, deadlineDelay);
    deadlineTimer?.unref?.();

    const stopError = () => {
      if (externallyAborted || externalSignal?.aborted) {
        return sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.ABORTED);
      }
      if (deadlineExpired || now() >= deadlineAt) {
        deadlineExpired = true;
        const error = sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.GLOBAL_TIMEOUT);
        if (!controller.signal.aborted) controller.abort(error);
        return error;
      }
      return null;
    };
    const throwIfStopped = () => {
      const error = stopError();
      if (error) throw error;
    };

    const executeProvider = async (provider) => {
      throwIfStopped();
      const attemptStartedAt = now();
      const remainingGlobalMs = Math.max(0, deadlineAt - attemptStartedAt);
      if (remainingGlobalMs === 0) throw stopError();
      const timeoutMs = Math.min(
        provider.descriptor.timeoutMs,
        providerTimeoutMs,
        remainingGlobalMs
      );
      const attemptController = new AbortController();
      let providerTimedOut = false;
      const abortFromManager = () => attemptController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortFromManager, { once: true });
      const providerTimer = setTimer(() => {
        providerTimedOut = true;
        attemptController.abort(sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.TIMEOUT));
      }, timeoutMs);
      providerTimer?.unref?.();

      let removeAbortRace = () => {};
      const abortRace = new Promise((resolve, reject) => {
        const onAbort = () => reject(attemptController.signal.reason ||
          sourceProviderError(SOURCE_PROVIDER_ERROR_CODES.ABORTED));
        removeAbortRace = () => attemptController.signal.removeEventListener('abort', onAbort);
        attemptController.signal.addEventListener('abort', onAbort, { once: true });
      });
      const runtime = Object.freeze({
        http,
        signal: attemptController.signal,
        deadlineAt: Math.min(deadlineAt, attemptStartedAt + timeoutMs),
      });
      const providerPromise = Promise.resolve().then(() =>
        provider.getSources(mediaContext, runtime));

      try {
        const raw = await Promise.race([providerPromise, abortRace]);
        throwIfStopped();
        if (!Array.isArray(raw)) {
          return {
            outcome: 'failed', candidates: [], discardedCandidates: 0,
            errorCode: SOURCE_PROVIDER_ERROR_CODES.INVALID_RESULT,
            durationMs: Math.max(0, now() - attemptStartedAt),
          };
        }

        const normalized = [];
        const identities = new Set();
        let discardedCandidates = 0;
        for (const item of raw) {
          const candidate = normalizeEmbedCandidate({ ...item, providerId: provider.descriptor.id });
          if (!candidate) {
            discardedCandidates += 1;
            continue;
          }
          const identity = candidateIdentity(candidate);
          if (identities.has(identity)) continue;
          identities.add(identity);
          normalized.push(candidate);
          if (normalized.length >= provider.descriptor.maxCandidates) break;
        }
        if (raw.length > 0 && normalized.length === 0) {
          return {
            outcome: 'failed', candidates: [], discardedCandidates,
            errorCode: SOURCE_PROVIDER_ERROR_CODES.INVALID_RESULT,
            durationMs: Math.max(0, now() - attemptStartedAt),
          };
        }
        return {
          outcome: 'success', candidates: normalized, discardedCandidates,
          durationMs: Math.max(0, now() - attemptStartedAt),
        };
      } catch {
        const stopped = stopError();
        if (stopped) throw stopped;
        return {
          outcome: providerTimedOut ? 'timeout' : 'failed',
          candidates: [],
          discardedCandidates: 0,
          errorCode: providerTimedOut
            ? SOURCE_PROVIDER_ERROR_CODES.TIMEOUT
            : SOURCE_PROVIDER_ERROR_CODES.FAILED,
          durationMs: Math.max(0, now() - attemptStartedAt),
        };
      } finally {
        clearTimer(providerTimer);
        removeAbortRace();
        controller.signal.removeEventListener('abort', abortFromManager);
      }
    };

    try {
      throwIfStopped();
      const allProviders = registry.list();
      const providers = registry.listForMedia(mediaContext);
      const results = new Array(providers.length);
      let nextIndex = 0;
      let discoveredCount = 0;

      const worker = async () => {
        while (true) {
          throwIfStopped();
          if (discoveredCount >= resultLimit) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= providers.length) return;
          const result = await executeProvider(providers[index]);
          results[index] = result;
          if (result.outcome === 'success') discoveredCount += result.candidates.length;
        }
      };
      const workers = Array.from(
        { length: Math.min(concurrency, providers.length) },
        () => worker()
      );
      await Promise.all(workers);
      throwIfStopped();

      const candidates = [];
      const identities = new Set();
      for (const result of results) {
        if (!result) continue;
        for (const candidate of result.candidates) {
          const identity = candidateIdentity(candidate);
          if (identities.has(identity)) continue;
          identities.add(identity);
          candidates.push(candidate);
          if (candidates.length >= resultLimit) break;
        }
        if (candidates.length >= resultLimit) break;
      }

      const attempts = results.map((result, index) => result && ({
        providerId: providers[index].descriptor.id,
        outcome: result.outcome,
        durationMs: result.durationMs,
        candidateCount: result.candidates.length,
        discardedCandidates: result.discardedCandidates,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      })).filter(Boolean);
      return {
        candidates,
        trace: {
          providersAttempted: attempts.length,
          providersSucceeded: attempts.filter(({ outcome }) => outcome === 'success').length,
          providersFailed: attempts.filter(({ outcome }) => outcome === 'failed').length,
          providersTimedOut: attempts.filter(({ outcome }) => outcome === 'timeout').length,
          providersSkipped: Math.max(0, allProviders.length - attempts.length),
          durationMs: Math.max(0, now() - startedAt),
          candidateCount: candidates.length,
          attempts,
        },
      };
    } finally {
      clearTimer(deadlineTimer);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  };

  return Object.freeze({ getSources });
};

module.exports = { createSourceProviderManager };
