'use strict';

const { normalizeMediaContext } = require('./resolverContracts');
const { createPrimaryAcceptanceGate, PRIMARY_CODES } = require('./primaryAcceptanceGate');

const PRIMARY_STATUSES = Object.freeze([
  'disabled', 'accepted', 'rejected', 'empty', 'timeout', 'aborted', 'failed',
]);
const safeDuration = (now, startedAt) => Math.max(0, now() - startedAt);

const createPrimaryResolver = ({
  pipeline,
  ranker,
  acceptanceGate = createPrimaryAcceptanceGate(),
  enabled = false,
  timeoutMs = 5_000,
  metrics = null,
  observability = null,
  logger = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!pipeline || typeof pipeline.resolve !== 'function' ||
      !ranker || typeof ranker.selectBest !== 'function' ||
      !acceptanceGate || typeof acceptanceGate.evaluate !== 'function' ||
      typeof enabled !== 'boolean' || !Number.isInteger(timeoutMs) ||
      timeoutMs < 500 || timeoutMs > 15_000 || typeof now !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('PRIMARY_RESOLVER_INVALID_CONFIG');
  }
  const emit = (method, name, value) => {
    try {
      const pending = metrics?.[method]?.(name, value);
      pending?.catch?.(() => {});
    } catch { /* best effort */ }
  };
  const finish = (status, startedAt, { selected = null, code = PRIMARY_CODES.UNKNOWN,
    streamCount = 0, summary = null, externalAbort = false } = {}) => {
    const durationMs = safeDuration(now, startedAt);
    const result = Object.freeze({ status, selected, summary: Object.freeze({
      code, streamCount: Number.isInteger(streamCount) ? streamCount : 0,
      durationMs, selection: summary,
    }), externalAbort });
    emit('increment', 'resolver_v2_primary_attempt_total', 1);
    const metric = {
      accepted: 'resolver_v2_primary_success_total',
      rejected: 'resolver_v2_primary_rejected_total',
      timeout: 'resolver_v2_primary_timeout_total',
      failed: 'resolver_v2_primary_failure_total',
    }[status];
    if (metric) emit('increment', metric, 1);
    emit('observe', 'resolver_v2_primary_duration_ms', durationMs);
    try { observability?.observe?.('primary_total', durationMs); } catch { /* best effort */ }
    try { logger?.log?.(`[ResolverV2Primary] ${status}`); } catch { /* best effort */ }
    return result;
  };
  const resolve = async (input, options = {}) => {
    if (!enabled) return Object.freeze({ status: 'disabled', selected: null,
      summary: Object.freeze({ code: PRIMARY_CODES.UNKNOWN, streamCount: 0, durationMs: 0,
        selection: null }), externalAbort: false });
    const startedAt = now();
    const mediaContext = normalizeMediaContext(input);
    if (!mediaContext || !options || typeof options !== 'object' || Array.isArray(options)) {
      return finish('failed', startedAt, { code: PRIMARY_CODES.INVALID_STREAM });
    }
    const externalSignal = options.signal || null;
    if (externalSignal?.aborted) {
      return finish('aborted', startedAt, { externalAbort: true });
    }
    const controller = new AbortController();
    let timedOut = false;
    let externalAbort = false;
    const abortFromExternal = () => { externalAbort = true; controller.abort(); };
    externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });
    const deadlineAt = Math.min(startedAt + timeoutMs,
      Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity);
    const timer = setTimer(() => { timedOut = true; controller.abort(); },
      Math.max(0, deadlineAt - now()));
    timer?.unref?.();
    let removeAbortRace = () => {};
    const abortRace = new Promise((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('PRIMARY_ABORTED'), {
        code: externalAbort ? 'PRIMARY_EXTERNAL_ABORT' : 'PRIMARY_TIMEOUT',
      }));
      removeAbortRace = () => controller.signal.removeEventListener('abort', onAbort);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (deadlineAt <= now()) {
        timedOut = true;
        throw Object.assign(new Error('PRIMARY_TIMEOUT'), { code: 'PRIMARY_TIMEOUT' });
      }
      const pipelineResult = await Promise.race([
        Promise.resolve().then(() => pipeline.resolve(mediaContext, {
          signal: controller.signal, deadlineAt,
        })),
        abortRace,
      ]);
      if (!pipelineResult || !Array.isArray(pipelineResult.streams)) {
        return finish('failed', startedAt);
      }
      const selection = pipelineResult.selection ||
        ranker.selectBest(pipelineResult.streams, { mediaContext });
      if (!selection?.selected) {
        return finish('empty', startedAt, {
          code: PRIMARY_CODES.NO_STREAM, streamCount: pipelineResult.streams.length,
        });
      }
      const gate = acceptanceGate.evaluate(selection.selected, { mediaContext });
      return finish(gate.accepted ? 'accepted' : 'rejected', startedAt, {
        selected: gate.accepted ? selection.selected : null,
        code: gate.code,
        streamCount: pipelineResult.streams.length,
        summary: gate.summary,
      });
    } catch (error) {
      const aborted = externalAbort || error?.code === 'PRIMARY_EXTERNAL_ABORT' ||
        error?.code === 'RESOLVER_ENGINE_ABORTED' || error?.code === 'SOURCE_PROVIDER_ABORTED';
      const timeout = timedOut || error?.code === 'PRIMARY_TIMEOUT' ||
        error?.code === 'RESOLVER_ENGINE_TIMEOUT' ||
        error?.code === 'SOURCE_PROVIDER_GLOBAL_TIMEOUT';
      return finish(aborted ? 'aborted' : timeout ? 'timeout' : 'failed', startedAt, {
        externalAbort: aborted,
      });
    } finally {
      clearTimer(timer);
      removeAbortRace();
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  };
  return Object.freeze({ enabled, resolve });
};

module.exports = { PRIMARY_STATUSES, createPrimaryResolver };
