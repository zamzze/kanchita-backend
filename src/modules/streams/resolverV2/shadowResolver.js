'use strict';

const { normalizeMediaContext } = require('./resolverContracts');

const SHADOW_STATUSES = Object.freeze([
  'disabled', 'no_providers', 'no_candidates', 'no_streams',
  'success', 'timeout', 'aborted', 'failed',
]);
const TIMEOUT_CODES = new Set([
  'SOURCE_PROVIDER_TIMEOUT',
  'SOURCE_PROVIDER_GLOBAL_TIMEOUT',
  'RESOLVER_ENGINE_TIMEOUT',
]);
const ABORT_CODES = new Set([
  'SOURCE_PROVIDER_ABORTED',
  'RESOLVER_ENGINE_ABORTED',
]);

const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const duration = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

const sanitizeSourceTrace = (trace) => ({
  providersAttempted: count(trace?.providersAttempted),
  providersSucceeded: count(trace?.providersSucceeded),
  providersFailed: count(trace?.providersFailed),
  providersTimedOut: count(trace?.providersTimedOut),
  providersCircuitOpen: count(trace?.providersCircuitOpen),
  providersSkipped: count(trace?.providersSkipped),
  durationMs: duration(trace?.durationMs),
  candidateCount: count(trace?.candidateCount),
});

const sanitizeResolverTrace = (trace) => {
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
  const outcomes = { resolved: 0, empty: 0, failed: 0, not_applicable: 0,
    circuit_open: 0 };
  for (const attempt of attempts) {
    if (Object.hasOwn(outcomes, attempt?.outcome)) outcomes[attempt.outcome] += 1;
  }
  return {
    attemptCount: attempts.length,
    outcomes,
    usedLegacyFallback: trace?.usedLegacyFallback === true,
    durationMs: duration(trace?.durationMs),
  };
};

const createShadowResolver = ({
  pipeline,
  enabled = false,
  timeoutMs = 1_500,
  metrics = { increment: async () => {}, observe: async () => {} },
  observability = null,
  logger = console,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!pipeline || typeof pipeline.resolve !== 'function' || typeof enabled !== 'boolean' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !metrics || typeof metrics.increment !== 'function' ||
      typeof metrics.observe !== 'function' || typeof now !== 'function' ||
      (observability && typeof observability.observe !== 'function') ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('INVALID_SHADOW_RESOLVER');
  }

  const metric = async (method, name, value) => {
    try {
      await metrics[method](name, value);
    } catch {
      // Shadow telemetry is best-effort and cannot affect the authoritative path.
    }
  };
  const logStatus = (status) => {
    const label = status === 'success' ? 'success'
      : status === 'timeout' ? 'timeout'
        : status === 'failed' ? 'failed' : 'empty';
    try {
      logger?.log?.(`[ResolverV2Shadow] ${label}`);
    } catch {
      // Logging is also non-authoritative.
    }
  };
  const safeResult = (status, startedAt, sourceTrace = null, resolverTrace = null,
    streamCount = 0) => ({
    status,
    streamCount: count(streamCount),
    candidateCount: count(sourceTrace?.candidateCount),
    durationMs: Math.max(0, now() - startedAt),
    sourceTrace,
    resolverTrace,
  });

  const run = async (input, options = {}) => {
    if (!enabled) return safeResult('disabled', now());
    const startedAt = now();
    const externalSignal = options?.signal || null;
    if (externalSignal?.aborted) return safeResult('aborted', startedAt);

    void metric('increment', 'resolver_v2_shadow_attempt_total', 1);
    let status = 'failed';
    let result = safeResult(status, startedAt);
    const controller = new AbortController();
    let externalAbort = false;
    let timedOut = false;
    const abortFromExternal = () => {
      externalAbort = true;
      controller.abort();
    };
    externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });
    const requestedDeadline = Number.isFinite(options?.deadlineAt)
      ? options.deadlineAt : Infinity;
    const deadlineAt = Math.min(startedAt + timeoutMs, requestedDeadline);
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(0, deadlineAt - now()));
    timer?.unref?.();

    let removeAbortRace = () => {};
    const abortRace = new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('SHADOW_ABORTED'), {
        code: externalAbort ? 'RESOLVER_ENGINE_ABORTED' : 'RESOLVER_ENGINE_TIMEOUT',
      }));
      removeAbortRace = () => controller.signal.removeEventListener('abort', onAbort);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const mediaContext = normalizeMediaContext(input);
      if (!mediaContext || !options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('INVALID_SHADOW_INPUT');
      }
      if (deadlineAt <= now()) {
        timedOut = true;
        throw Object.assign(new Error('SHADOW_TIMEOUT'), {
          code: 'RESOLVER_ENGINE_TIMEOUT',
        });
      }
      const pipelinePromise = Promise.resolve().then(() => pipeline.resolve(mediaContext, {
        signal: controller.signal,
        deadlineAt,
      }));
      const pipelineResult = await Promise.race([pipelinePromise, abortRace]);
      if (!pipelineResult || !Array.isArray(pipelineResult.streams) ||
          !pipelineResult.sourceTrace || typeof pipelineResult.sourceTrace !== 'object' ||
          Array.isArray(pipelineResult.sourceTrace) ||
          !pipelineResult.resolverTrace || typeof pipelineResult.resolverTrace !== 'object' ||
          Array.isArray(pipelineResult.resolverTrace)) {
        throw new Error('INVALID_SHADOW_RESULT');
      }
      const sourceTrace = sanitizeSourceTrace(pipelineResult.sourceTrace);
      const resolverTrace = sanitizeResolverTrace(pipelineResult.resolverTrace);
      const streamCount = pipelineResult.streams.length;
      status = streamCount > 0 ? 'success'
        : sourceTrace.providersAttempted === 0 ? 'no_providers'
          : sourceTrace.candidateCount === 0 ? 'no_candidates' : 'no_streams';
      result = safeResult(status, startedAt, sourceTrace, resolverTrace, streamCount);
    } catch (error) {
      status = externalAbort || ABORT_CODES.has(error?.code) ? 'aborted'
        : timedOut || TIMEOUT_CODES.has(error?.code) ? 'timeout' : 'failed';
      result = safeResult(status, startedAt);
    } finally {
      clearTimer(timer);
      removeAbortRace();
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }

    if (status === 'success') {
      void metric('increment', 'resolver_v2_shadow_success_total', 1);
    } else if (status === 'timeout') {
      void metric('increment', 'resolver_v2_shadow_timeout_total', 1);
    } else if (status === 'failed') {
      void metric('increment', 'resolver_v2_shadow_failure_total', 1);
    } else if (status !== 'aborted') {
      void metric('increment', 'resolver_v2_shadow_empty_total', 1);
    }
    void metric('observe', 'resolver_v2_shadow_duration_ms', result.durationMs);
    try { observability?.observe('shadow_total', result.durationMs); } catch {
      // In-memory observability is best-effort.
    }
    logStatus(status);
    return result;
  };

  return Object.freeze({ enabled, run });
};

module.exports = { SHADOW_STATUSES, createShadowResolver, sanitizeSourceTrace,
  sanitizeResolverTrace };
