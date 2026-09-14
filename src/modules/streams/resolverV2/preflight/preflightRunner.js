'use strict';

const { normalizeMediaContext } = require('../resolverContracts');
const { classifyLanguage, qualityTier } = require('../ranking/streamRanker');
const { PRIMARY_CODES, createPrimaryAcceptanceGate } = require('../primaryAcceptanceGate');
const { PREFLIGHT_CODES, preflightError, sanitizePreflightError } = require('./preflightErrors');

const STATUSES = Object.freeze([
  'ready', 'no_sources', 'no_candidates', 'no_streams', 'rejected',
  'timeout', 'failed', 'aborted', 'invalid_context',
]);
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 30_000;
const SAFE_CATALOG_CODE = /^CATALOG_[A-Z0-9_]{1,63}$/;
const LANGUAGE_KEYS = Object.freeze(['latino', 'castellano', 'vose', 'vo', 'unknown']);
const QUALITY_KEYS = Object.freeze(['1080p', '720p', 'auto', '480p', '2160p', 'unknown']);
const PROTOCOL_KEYS = Object.freeze(['hls', 'mp4', 'dash', 'unknown']);
const HEALTH_STATES = Object.freeze(['closed', 'open', 'half_open']);

const countMap = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const boundedCount = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const safeDuration = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

const syntheticMediaContext = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const identity = input.contentType === 'episode'
    ? `preflight:episode:${input.tmdbId}:${input.season}:${input.episode}`
    : `preflight:movie:${input.tmdbId}`;
  return normalizeMediaContext({
    contentType: input.contentType,
    contentId: identity,
    tmdbId: input.tmdbId,
    title: 'Resolver V2 preflight',
    season: input.season,
    episode: input.episode,
  });
};

const safeCatalogSummary = (summary, enabled) => Object.freeze({
  enabled: enabled === true,
  loaded: summary?.loaded === true,
  version: summary?.version === 1 ? 1 : null,
  sourcesRegistered: boundedCount(summary?.sourcesRegistered),
  resolversRegistered: boundedCount(summary?.resolversRegistered),
  entriesSkipped: boundedCount(summary?.sourcesSkipped) +
    boundedCount(summary?.resolversSkipped),
  errorCodes: Object.freeze(Array.isArray(summary?.errorCodes)
    ? summary.errorCodes.filter((code) => typeof code === 'string' && SAFE_CATALOG_CODE.test(code))
    : []),
});

const safeSourceSummary = (trace, registered, eligible) => Object.freeze({
  registered: boundedCount(registered),
  eligible: boundedCount(eligible),
  attempted: boundedCount(trace?.providersAttempted),
  succeeded: boundedCount(trace?.providersSucceeded),
  empty: Array.isArray(trace?.attempts)
    ? trace.attempts.filter(({ outcome, candidateCount }) =>
      outcome === 'success' && candidateCount === 0).length : 0,
  failed: boundedCount(trace?.providersFailed),
  timedOut: boundedCount(trace?.providersTimedOut),
  circuitOpen: boundedCount(trace?.providersCircuitOpen),
  candidates: boundedCount(trace?.candidateCount),
});

const safeResolverSummary = (trace, registered, streamCount) => {
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
  const actual = attempts.filter(({ resolverId, outcome }) =>
    resolverId !== null && outcome !== 'not_applicable');
  return Object.freeze({
    registered: boundedCount(registered),
    attempted: actual.filter(({ outcome }) => outcome !== 'circuit_open').length,
    succeeded: actual.filter(({ outcome }) => outcome === 'resolved').length,
    empty: actual.filter(({ outcome }) => outcome === 'empty').length,
    failed: actual.filter(({ outcome }) => outcome === 'failed').length,
    timedOut: actual.filter(({ outcome, errorCode }) => outcome === 'failed' &&
      (errorCode === 'HTTP_TIMEOUT' || errorCode === 'RESOLVER_ENGINE_TIMEOUT')).length,
    circuitOpen: actual.filter(({ outcome }) => outcome === 'circuit_open').length,
    streams: boundedCount(streamCount),
  });
};

const safeHealthSummary = (healthStore) => {
  const summary = { sources: countMap(HEALTH_STATES), resolvers: countMap(HEALTH_STATES) };
  let snapshot = [];
  try { snapshot = healthStore?.snapshot?.() || []; } catch { snapshot = []; }
  if (Array.isArray(snapshot)) {
    for (const entry of snapshot) {
      const group = entry?.kind === 'source' ? summary.sources
        : entry?.kind === 'resolver' ? summary.resolvers : null;
      if (group && HEALTH_STATES.includes(entry.state)) group[entry.state] += 1;
    }
  }
  return Object.freeze({
    sources: Object.freeze({ closed: summary.sources.closed, open: summary.sources.open,
      halfOpen: summary.sources.half_open }),
    resolvers: Object.freeze({ closed: summary.resolvers.closed, open: summary.resolvers.open,
      halfOpen: summary.resolvers.half_open }),
  });
};

const percentile = (snapshot, series, key) => {
  const value = snapshot?.latency?.[series]?.[key];
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const safeObservabilitySummary = (observability, durationMs) => {
  let snapshot = null;
  try { snapshot = observability?.snapshot?.() || null; } catch { snapshot = null; }
  const pair = (series) => Object.freeze({
    p50: percentile(snapshot, series, 'p50'), p95: percentile(snapshot, series, 'p95'),
  });
  return Object.freeze({
    sourceHttpMs: pair('source_http'),
    resolverHttpMs: pair('resolver_http'),
    resolverDirectMs: pair('resolver_direct'),
    totalMs: Object.freeze({ p50: safeDuration(durationMs), p95: safeDuration(durationMs) }),
  });
};

const safeRankingSummary = (streams, selection) => {
  const languages = countMap(LANGUAGE_KEYS);
  const qualities = countMap(QUALITY_KEYS);
  const protocols = countMap(PROTOCOL_KEYS);
  for (const stream of streams) {
    const language = classifyLanguage(stream.audioLanguage, stream.subtitleLanguage).tier;
    const quality = qualityTier(stream);
    const protocol = PROTOCOL_KEYS.includes(stream.protocol) ? stream.protocol : 'unknown';
    languages[LANGUAGE_KEYS.includes(language) ? language : 'unknown'] += 1;
    qualities[QUALITY_KEYS.includes(quality) ? quality : 'unknown'] += 1;
    protocols[protocol] += 1;
  }
  const reason = selection?.reason;
  return Object.freeze({
    streamCount: streams.length,
    languages: Object.freeze(languages),
    qualities: Object.freeze(qualities),
    protocols: Object.freeze(protocols),
    selected: selection?.selected ? Object.freeze({
      validated: selection.selected.validated === true,
      protocolTier: PROTOCOL_KEYS.includes(reason?.protocolTier)
        ? reason.protocolTier : 'unknown',
      languageTier: LANGUAGE_KEYS.includes(reason?.languageTier)
        ? reason.languageTier : 'unknown',
      qualityTier: QUALITY_KEYS.includes(reason?.qualityTier)
        ? reason.qualityTier : 'unknown',
    }) : null,
  });
};

const baseResult = ({ status, mediaType, catalog, sourceSummary, resolverSummary,
  rankingSummary, acceptanceSummary, healthSummary, observabilitySummary,
  durationMs, error }) => Object.freeze({
  status,
  mediaType: mediaType === 'movie' || mediaType === 'episode' ? mediaType : null,
  catalog,
  sourceSummary,
  resolverSummary,
  rankingSummary,
  acceptanceSummary,
  healthSummary,
  observabilitySummary,
  durationMs: safeDuration(durationMs),
  ...(error ? { error } : {}),
});

const createPreflightRunner = ({
  runtime,
  acceptanceGate = createPrimaryAcceptanceGate(),
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  catalogEnabled = false,
} = {}) => {
  if (!runtime || typeof runtime !== 'object' ||
      typeof runtime.pipeline?.resolve !== 'function' ||
      typeof runtime.sourceRegistry?.list !== 'function' ||
      typeof runtime.sourceRegistry?.listForMedia !== 'function' ||
      typeof runtime.resolverRegistry?.list !== 'function' ||
      typeof runtime.ranker?.selectBest !== 'function' ||
      typeof acceptanceGate?.evaluate !== 'function' || typeof clock !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw preflightError(PREFLIGHT_CODES.RUNTIME_FAILED);
  }

  const catalog = () => safeCatalogSummary(runtime.catalogSummary, catalogEnabled);
  const emptySources = (registered = 0, eligible = 0) =>
    safeSourceSummary(null, registered, eligible);
  const emptyResolvers = (registered = 0) => safeResolverSummary(null, registered, 0);
  const emptyRanking = () => safeRankingSummary([], null);
  const noAcceptance = () => Object.freeze({ accepted: false,
    code: PRIMARY_CODES.NO_STREAM, headersSupported: true });

  const run = async (input, options = {}) => {
    const startedAt = clock();
    const timeoutMs = options?.timeoutMs === undefined ? 10_000 : options.timeoutMs;
    const catalogOnly = options?.catalogOnly === true;
    const externalSignal = options?.signal || null;
    const catalogSummary = catalog();
    const sourceRegistered = runtime.sourceRegistry.list().length;
    const resolverRegistered = runtime.resolverRegistry.list().length;
    const finish = (fields) => baseResult({
      catalog: catalogSummary,
      sourceSummary: emptySources(sourceRegistered),
      resolverSummary: emptyResolvers(resolverRegistered),
      rankingSummary: emptyRanking(),
      acceptanceSummary: noAcceptance(),
      healthSummary: safeHealthSummary(runtime.healthStore),
      observabilitySummary: safeObservabilitySummary(runtime.observability,
        Math.max(0, clock() - startedAt)),
      durationMs: Math.max(0, clock() - startedAt),
      ...fields,
    });

    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        !Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS ||
        timeoutMs > TIMEOUT_MAX_MS || (externalSignal &&
          (typeof externalSignal.aborted !== 'boolean' ||
            typeof externalSignal.addEventListener !== 'function'))) {
      return finish({ status: 'invalid_context', mediaType: null,
        error: sanitizePreflightError(preflightError(PREFLIGHT_CODES.INVALID_CONTEXT)) });
    }
    if (catalogEnabled === true && catalogSummary.loaded !== true) {
      return finish({ status: 'failed', mediaType: null,
        error: sanitizePreflightError(preflightError(PREFLIGHT_CODES.CATALOG_FAILED)) });
    }
    if (catalogOnly) return finish({ status: 'ready', mediaType: null });

    const mediaContext = syntheticMediaContext(input);
    if (!mediaContext) {
      return finish({ status: 'invalid_context', mediaType: null,
        error: sanitizePreflightError(preflightError(PREFLIGHT_CODES.INVALID_CONTEXT)) });
    }
    let eligible;
    try { eligible = runtime.sourceRegistry.listForMedia(mediaContext).length; } catch {
      return finish({ status: 'failed', mediaType: mediaContext.contentType,
        error: sanitizePreflightError(preflightError(PREFLIGHT_CODES.RUNTIME_FAILED)) });
    }
    if (eligible === 0) {
      return finish({ status: 'no_sources', mediaType: mediaContext.contentType,
        sourceSummary: emptySources(sourceRegistered, 0),
        error: Object.freeze({ code: PREFLIGHT_CODES.NO_SOURCES }) });
    }

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = externalSignal?.aborted === true;
    const abortExternal = () => {
      externallyAborted = true;
      controller.abort(preflightError(PREFLIGHT_CODES.ABORTED));
    };
    if (externalSignal && !externallyAborted) {
      externalSignal.addEventListener('abort', abortExternal, { once: true });
    }
    const deadlineAt = startedAt + timeoutMs;
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort(preflightError(PREFLIGHT_CODES.TIMEOUT));
    }, Math.max(0, deadlineAt - clock()));
    timer?.unref?.();
    let abortRaceHandler = null;
    const aborted = new Promise((resolve, reject) => {
      abortRaceHandler = () => reject(controller.signal.reason ||
        preflightError(PREFLIGHT_CODES.ABORTED));
      if (controller.signal.aborted) abortRaceHandler();
      else controller.signal.addEventListener('abort', abortRaceHandler, { once: true });
    });

    try {
      if (externallyAborted) throw preflightError(PREFLIGHT_CODES.ABORTED);
      const resolved = await Promise.race([
        Promise.resolve().then(() => runtime.pipeline.resolve(mediaContext, {
          signal: controller.signal, deadlineAt,
        })),
        aborted,
      ]);
      if (!resolved || !Array.isArray(resolved.streams) || !resolved.sourceTrace ||
          !resolved.resolverTrace) throw preflightError(PREFLIGHT_CODES.RUNTIME_FAILED);
      const sourceSummary = safeSourceSummary(resolved.sourceTrace,
        sourceRegistered, eligible);
      const selection = runtime.ranker.selectBest(resolved.streams, { mediaContext });
      if (!selection || !Array.isArray(selection.ranked)) {
        throw preflightError(PREFLIGHT_CODES.RUNTIME_FAILED);
      }
      const rankingSummary = safeRankingSummary(selection.ranked, selection);
      const resolverSummary = safeResolverSummary(resolved.resolverTrace,
        resolverRegistered, selection.ranked.length);
      const gate = acceptanceGate.evaluate(selection.selected);
      if (!gate || typeof gate.accepted !== 'boolean' ||
          typeof gate.code !== 'string' || !/^PRIMARY_[A-Z0-9_]{1,63}$/.test(gate.code)) {
        throw preflightError(PREFLIGHT_CODES.RUNTIME_FAILED);
      }
      const acceptanceSummary = Object.freeze({
        accepted: gate.accepted,
        code: gate.code,
        headersSupported: ![
          PRIMARY_CODES.HEADERS_UNSUPPORTED,
          PRIMARY_CODES.HEADERS_INVALID,
        ].includes(gate.code),
      });
      const common = { mediaType: mediaContext.contentType, sourceSummary,
        resolverSummary, rankingSummary, acceptanceSummary };
      if (sourceSummary.candidates === 0) {
        return finish({ ...common, status: 'no_candidates',
          error: Object.freeze({ code: PREFLIGHT_CODES.NO_CANDIDATES }) });
      }
      if (rankingSummary.streamCount === 0) {
        return finish({ ...common, status: 'no_streams',
          error: Object.freeze({ code: PREFLIGHT_CODES.NO_STREAMS }) });
      }
      if (!gate.accepted) {
        return finish({ ...common, status: 'rejected',
          error: Object.freeze({ code: PREFLIGHT_CODES.REJECTED }) });
      }
      return finish({ ...common, status: 'ready' });
    } catch (error) {
      const safe = timedOut
        ? Object.freeze({ code: PREFLIGHT_CODES.TIMEOUT })
        : externallyAborted
          ? Object.freeze({ code: PREFLIGHT_CODES.ABORTED })
          : sanitizePreflightError(error);
      return finish({ status: safe.code === PREFLIGHT_CODES.TIMEOUT ? 'timeout'
        : safe.code === PREFLIGHT_CODES.ABORTED ? 'aborted' : 'failed',
      mediaType: mediaContext.contentType, error: safe,
      sourceSummary: emptySources(sourceRegistered, eligible) });
    } finally {
      clearTimer(timer);
      controller.signal.removeEventListener('abort', abortRaceHandler);
      externalSignal?.removeEventListener?.('abort', abortExternal);
    }
  };

  return Object.freeze({ run, statuses: STATUSES });
};

module.exports = {
  STATUSES,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  createPreflightRunner,
  syntheticMediaContext,
};
