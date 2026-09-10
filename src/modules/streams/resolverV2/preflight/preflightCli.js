'use strict';

const { PREFLIGHT_CODES } = require('./preflightErrors');
const { TIMEOUT_MIN_MS, TIMEOUT_MAX_MS } = require('./preflightRunner');

const EXIT_CODES = Object.freeze({ ready: 0, invalid: 2, unavailable: 3, timeout: 4,
  failed: 5 });
const STATUS_EXIT = Object.freeze({
  ready: EXIT_CODES.ready,
  no_sources: EXIT_CODES.unavailable,
  no_candidates: EXIT_CODES.unavailable,
  no_streams: EXIT_CODES.unavailable,
  rejected: EXIT_CODES.unavailable,
  timeout: EXIT_CODES.timeout,
  failed: EXIT_CODES.failed,
  invalid_context: EXIT_CODES.failed,
  aborted: EXIT_CODES.failed,
});

const positiveInteger = (value, { allowZero = false } = {}) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
};

const invalid = (json = false) => Object.freeze({
  ok: false,
  json,
  error: Object.freeze({ code: PREFLIGHT_CODES.INVALID_INPUT }),
});

const parsePreflightArgs = (argv = []) => {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return invalid();
  const values = new Map();
  let json = false;
  let catalogOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json' || argument === '--catalog-only') {
      if ((argument === '--json' && json) || (argument === '--catalog-only' && catalogOnly)) {
        return invalid(json || argument === '--json');
      }
      if (argument === '--json') json = true;
      else catalogOnly = true;
      continue;
    }
    if (!['--movie', '--episode', '--season', '--episode-number', '--timeout-ms']
      .includes(argument) || values.has(argument) || index + 1 >= argv.length ||
      argv[index + 1].startsWith('--')) return invalid(json);
    values.set(argument, argv[index + 1]);
    index += 1;
  }

  const timeoutMs = values.has('--timeout-ms')
    ? positiveInteger(values.get('--timeout-ms')) : 10_000;
  if (timeoutMs === null || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    return invalid(json);
  }
  const hasMovie = values.has('--movie');
  const hasEpisode = values.has('--episode');
  const hasSeason = values.has('--season');
  const hasEpisodeNumber = values.has('--episode-number');
  if (catalogOnly) {
    if (hasMovie || hasEpisode || hasSeason || hasEpisodeNumber) return invalid(json);
    return Object.freeze({ ok: true, json, catalogOnly: true, timeoutMs,
      mediaContext: null });
  }
  if (hasMovie === hasEpisode) return invalid(json);
  if (hasMovie) {
    if (hasSeason || hasEpisodeNumber) return invalid(json);
    const tmdbId = positiveInteger(values.get('--movie'));
    if (tmdbId === null) return invalid(json);
    return Object.freeze({ ok: true, json, catalogOnly: false, timeoutMs,
      mediaContext: Object.freeze({ contentType: 'movie', tmdbId }) });
  }
  const tmdbId = positiveInteger(values.get('--episode'));
  const season = positiveInteger(values.get('--season'), { allowZero: true });
  const episode = positiveInteger(values.get('--episode-number'));
  if (tmdbId === null || season === null || episode === null || !hasSeason ||
      !hasEpisodeNumber) return invalid(json);
  return Object.freeze({ ok: true, json, catalogOnly: false, timeoutMs,
    mediaContext: Object.freeze({ contentType: 'episode', tmdbId, season, episode }) });
};

const exitCodeForStatus = (status, { cliInputInvalid = false } = {}) =>
  cliInputInvalid ? EXIT_CODES.invalid : STATUS_EXIT[status] ?? EXIT_CODES.failed;

const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const safeCode = (value, fallback) => typeof value === 'string' &&
  /^(?:PREFLIGHT|PRIMARY|CATALOG)_[A-Z0-9_]{1,63}$/.test(value) ? value : fallback;
const tier = (value, allowed) => allowed.includes(value) ? value : 'unknown';

const safeOutput = (result = {}) => {
  const catalog = result.catalog || {};
  const source = result.sourceSummary || {};
  const resolver = result.resolverSummary || {};
  const ranking = result.rankingSummary || {};
  const acceptance = result.acceptanceSummary || {};
  const health = result.healthSummary || {};
  const latency = result.observabilitySummary || {};
  const countGroup = (input, keys) => Object.fromEntries(keys.map((key) =>
    [key, count(input?.[key])]));
  const latencyPair = (input) => ({
    p50: Number.isFinite(input?.p50) && input.p50 >= 0 ? input.p50 : null,
    p95: Number.isFinite(input?.p95) && input.p95 >= 0 ? input.p95 : null,
  });
  return {
    status: ['ready', 'no_sources', 'no_candidates', 'no_streams', 'rejected',
      'timeout', 'failed', 'aborted', 'invalid_context'].includes(result.status)
      ? result.status : 'failed',
    mediaType: ['movie', 'episode'].includes(result.mediaType) ? result.mediaType : null,
    catalog: {
      enabled: catalog.enabled === true,
      loaded: catalog.loaded === true,
      version: catalog.version === 1 ? 1 : null,
      sourcesRegistered: count(catalog.sourcesRegistered),
      resolversRegistered: count(catalog.resolversRegistered),
      entriesSkipped: count(catalog.entriesSkipped),
      errorCodes: Array.isArray(catalog.errorCodes)
        ? catalog.errorCodes.filter((code) => /^CATALOG_[A-Z0-9_]{1,63}$/.test(code)) : [],
    },
    sourceSummary: {
      registered: count(source.registered), eligible: count(source.eligible),
      attempted: count(source.attempted), succeeded: count(source.succeeded),
      empty: count(source.empty), failed: count(source.failed),
      timedOut: count(source.timedOut), circuitOpen: count(source.circuitOpen),
      candidates: count(source.candidates),
    },
    resolverSummary: {
      registered: count(resolver.registered), attempted: count(resolver.attempted),
      succeeded: count(resolver.succeeded), empty: count(resolver.empty),
      failed: count(resolver.failed), timedOut: count(resolver.timedOut),
      circuitOpen: count(resolver.circuitOpen), streams: count(resolver.streams),
    },
    rankingSummary: {
      streamCount: count(ranking.streamCount),
      languages: countGroup(ranking.languages,
        ['latino', 'castellano', 'vose', 'vo', 'unknown']),
      qualities: countGroup(ranking.qualities,
        ['1080p', '720p', 'auto', '480p', '2160p', 'unknown']),
      protocols: countGroup(ranking.protocols, ['hls', 'mp4', 'dash', 'unknown']),
      selected: ranking.selected ? {
        validated: ranking.selected.validated === true,
        protocolTier: tier(ranking.selected.protocolTier, ['hls', 'mp4', 'dash', 'unknown']),
        languageTier: tier(ranking.selected.languageTier,
          ['latino', 'castellano', 'vose', 'vo', 'unknown']),
        qualityTier: tier(ranking.selected.qualityTier,
          ['1080p', '720p', 'auto', '480p', '2160p', 'unknown']),
      } : null,
    },
    acceptanceSummary: {
      accepted: acceptance.accepted === true,
      code: safeCode(acceptance.code, 'PRIMARY_NO_STREAM'),
      headersSupported: acceptance.headersSupported !== false,
    },
    healthSummary: {
      sources: countGroup(health.sources, ['closed', 'open', 'halfOpen']),
      resolvers: countGroup(health.resolvers, ['closed', 'open', 'halfOpen']),
    },
    observabilitySummary: {
      sourceHttpMs: latencyPair(latency.sourceHttpMs),
      resolverHttpMs: latencyPair(latency.resolverHttpMs),
      resolverDirectMs: latencyPair(latency.resolverDirectMs),
      totalMs: latencyPair(latency.totalMs),
    },
    durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? result.durationMs : 0,
    ...(result.error ? { error: {
      code: safeCode(result.error.code, PREFLIGHT_CODES.RUNTIME_FAILED),
    } } : {}),
  };
};

const formatPreflightJson = (result) => JSON.stringify(safeOutput(result));

const formatPreflightText = (result) => {
  const safe = safeOutput(result);
  const lines = [
    'Resolver V2 preflight',
    `status=${safe.status}`,
    `media_type=${safe.mediaType || 'none'}`,
    `catalog.enabled=${safe.catalog.enabled}`,
    `catalog.loaded=${safe.catalog.loaded}`,
    `catalog.version=${safe.catalog.version ?? 'none'}`,
    `catalog.sources_registered=${safe.catalog.sourcesRegistered}`,
    `catalog.resolvers_registered=${safe.catalog.resolversRegistered}`,
    `catalog.entries_skipped=${safe.catalog.entriesSkipped}`,
    `catalog.error_codes=${safe.catalog.errorCodes.join(',') || 'none'}`,
    `sources.registered=${safe.sourceSummary.registered}`,
    `sources.eligible=${safe.sourceSummary.eligible}`,
    `sources.attempted=${safe.sourceSummary.attempted}`,
    `sources.succeeded=${safe.sourceSummary.succeeded}`,
    `sources.empty=${safe.sourceSummary.empty}`,
    `sources.failed=${safe.sourceSummary.failed}`,
    `sources.timed_out=${safe.sourceSummary.timedOut}`,
    `sources.circuit_open=${safe.sourceSummary.circuitOpen}`,
    `candidates=${safe.sourceSummary.candidates}`,
    `resolvers.registered=${safe.resolverSummary.registered}`,
    `resolvers.attempted=${safe.resolverSummary.attempted}`,
    `resolvers.succeeded=${safe.resolverSummary.succeeded}`,
    `resolvers.empty=${safe.resolverSummary.empty}`,
    `resolvers.failed=${safe.resolverSummary.failed}`,
    `resolvers.timed_out=${safe.resolverSummary.timedOut}`,
    `resolvers.circuit_open=${safe.resolverSummary.circuitOpen}`,
    `streams=${safe.rankingSummary.streamCount}`,
    `selected.protocol=${safe.rankingSummary.selected?.protocolTier || 'none'}`,
    `selected.language=${safe.rankingSummary.selected?.languageTier || 'none'}`,
    `selected.quality=${safe.rankingSummary.selected?.qualityTier || 'none'}`,
    `selected.validated=${safe.rankingSummary.selected?.validated === true}`,
    `primary.accepted=${safe.acceptanceSummary.accepted}`,
    `primary.code=${safe.acceptanceSummary.code}`,
    `primary.headers_supported=${safe.acceptanceSummary.headersSupported}`,
    `health.sources.closed=${safe.healthSummary.sources.closed}`,
    `health.sources.open=${safe.healthSummary.sources.open}`,
    `health.sources.half_open=${safe.healthSummary.sources.halfOpen}`,
    `health.resolvers.closed=${safe.healthSummary.resolvers.closed}`,
    `health.resolvers.open=${safe.healthSummary.resolvers.open}`,
    `health.resolvers.half_open=${safe.healthSummary.resolvers.halfOpen}`,
    `duration_ms=${safe.durationMs}`,
  ];
  if (safe.error) lines.push(`error.code=${safe.error.code}`);
  return lines.join('\n');
};

module.exports = {
  EXIT_CODES,
  parsePreflightArgs,
  exitCodeForStatus,
  safeOutput,
  formatPreflightJson,
  formatPreflightText,
};
