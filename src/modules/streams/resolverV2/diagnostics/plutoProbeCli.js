'use strict';

const { createSafeHttpClient } = require('../../http/safeHttpClient');
const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');
const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createPlutoSourceProvider, DEFAULT_BASE_URL, DEFAULT_BOOT_URL } =
  require('../providers/plutoSourceProvider');

// Public LATAM movie URL observed in Pluto's indexed web surface. Diagnostic only.
const DIAGNOSTIC_VOD_ID = '69d91bb1bf7771122425d2ba';
// Public LATAM series page observed in Pluto's indexed web surface. Diagnostic only.
const DIAGNOSTIC_SERIES_ID = '6826044d00cabfe6fec3d143';
const BOOLEAN_FLAGS = new Set([
  '--json', '--discover', '--vod-discover', '--episode-discover',
]);
const VALUE_FLAGS = new Set([
  '--content-type', '--tmdb-id', '--season', '--episode', '--pluto-id',
  '--base-url', '--boot-url', '--timeout-ms',
]);

const parseArgs = (argv = []) => {
  const options = { json: false, discover: false, vodDiscover: false,
    episodeDiscover: false, contentType: 'movie', baseUrl: DEFAULT_BASE_URL,
    bootUrl: DEFAULT_BOOT_URL, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { ok: false, json: options.json };
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      return { ok: false, json: options.json };
    }
    index += 1;
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  const tmdbId = Number(options.tmdbId);
  const season = options.season === undefined ? null : Number(options.season);
  const episode = options.episode === undefined ? null : Number(options.episode);
  const timeoutMs = Number(options.timeoutMs);
  const hasExplicitMapping = options.tmdbId !== undefined || options.plutoId !== undefined ||
    options.season !== undefined || options.episode !== undefined;
  const discoveryModes = [options.discover, options.vodDiscover, options.episodeDiscover]
    .filter(Boolean).length;
  if (!['movie', 'episode'].includes(options.contentType) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 ||
      discoveryModes > 1 || (discoveryModes === 1 && hasExplicitMapping) ||
      (discoveryModes === 0 && (!Number.isInteger(tmdbId) || tmdbId < 1 ||
        typeof options.plutoId !== 'string' || !options.plutoId.trim())) ||
      (discoveryModes === 0 && options.contentType === 'episode' &&
        (!Number.isInteger(season) || season < 0 ||
          !Number.isInteger(episode) || episode < 1))) {
    return { ok: false, json: options.json };
  }
  return { ok: true, json: options.json, value: Object.freeze({
    discover: options.discover,
    vodDiscover: options.vodDiscover,
    episodeDiscover: options.episodeDiscover,
    contentType: options.contentType,
    tmdbId: discoveryModes ? null : tmdbId,
    season: discoveryModes ? null : season,
    episode: discoveryModes ? null : episode,
    plutoId: discoveryModes ? null : options.plutoId.trim(),
    baseUrl: options.baseUrl,
    bootUrl: options.bootUrl,
    timeoutMs,
  }) };
};

const safeHlsSummary = (stream) => {
  const info = stream?.hlsInfo || {};
  return Object.freeze({
    variants: Array.isArray(info.variants) ? info.variants.length : 0,
    audio: Array.isArray(info.audioTracks) ? Math.min(info.audioTracks.length, 16) : 0,
    subtitles: Array.isArray(info.subtitleTracks)
      ? Math.min(info.subtitleTracks.length, 16) : 0,
  });
};

const createPlutoProbe = ({ httpClient, clock = Date.now } = {}) => {
  const run = async (input) => {
    const startedAt = clock();
    const result = {
      status: 'failed',
      boot_ok: false,
      discovery_endpoint_type: input.discover ? 'boot_epg'
        : input.vodDiscover ? 'exact_vod_item'
          : input.episodeDiscover ? 'series_first_season' : 'explicit_mapping',
      response_bytes_read: 0,
      items_inspected: 0,
      pluto_id: null,
      content_kind: null,
      show_identifier: input.episodeDiscover ? DIAGNOSTIC_SERIES_ID : null,
      season: null,
      episode: null,
      episode_found: false,
      exact_episode_id: false,
      exact_item_request: input.discover !== true,
      requests_with_cached_boot: null,
      catalog_requests: 0,
      search_requests: 0,
      series_requests: 0,
      season_requests: 0,
      browser_requests: 0,
      hls_found: false,
      hls_valid: false,
      variants: 0,
      audio: 0,
      subtitles: 0,
      session_requirement: 'unknown',
      temporary_url: false,
      expiry_detected: false,
      remaining_lifetime_seconds: null,
      latency_ms: 0,
    };
    const requestCounts = { exactItem: 0, catalog: 0, search: 0, series: 0, season: 0 };
    try {
      const transport = httpClient || createSafeHttpClient({ timeoutMs: input.timeoutMs });
      const countRequest = (rawUrl) => {
        let pathname = '';
        try { pathname = new URL(rawUrl).pathname.toLowerCase(); } catch { return; }
        if (pathname.includes('/categories')) requestCounts.catalog += 1;
        if (pathname.includes('/search')) requestCounts.search += 1;
        if (pathname.includes('/v4/vod/series/')) requestCounts.series += 1;
        if (/\/v4\/vod\/series\/[^/]+\/seasons\/?$/.test(pathname)) {
          requestCounts.season += 1;
        }
        if (pathname === '/v4/vod/items' ||
            /\/v2\/episodes\/[^/]+\/clips\.json$/.test(pathname)) {
          requestCounts.exactItem += 1;
        }
      };
      const client = Object.freeze({
        get: async (url, options) => {
          countRequest(url);
          return transport.get(url, options);
        },
        ...(typeof transport.head === 'function'
          ? { head: (url, options) => transport.head(url, options) } : {}),
      });
      let mapping = input;
      let provider = null;
      if (input.episodeDiscover) {
        const discoveryProvider = createPlutoSourceProvider({
          id: 'pluto_episode_discovery', enabled: true, baseUrl: input.baseUrl,
          bootUrl: input.bootUrl, timeoutMs: input.timeoutMs,
          mediaMap: [], http: client,
        });
        provider = discoveryProvider;
        const discovered = await discoveryProvider.discoverEpisode({
          seriesId: DIAGNOSTIC_SERIES_ID,
          onStage: (stage) => {
            if (stage === 'boot') result.boot_ok = true;
          },
        });
        result.items_inspected = discovered.itemsChecked;
        result.pluto_id = discovered.plutoId;
        result.content_kind = 'episode';
        result.season = discovered.season;
        result.episode = discovered.episode;
        if (!discovered.plutoId) {
          result.status = 'no_public_item';
          mapping = null;
        } else {
          mapping = Object.freeze({ ...input, contentType: 'episode', tmdbId: 1,
            season: discovered.season, episode: discovered.episode,
            plutoId: discovered.plutoId });
        }
      } else if (input.vodDiscover) {
        mapping = Object.freeze({ ...input, contentType: 'movie', tmdbId: 1,
          season: null, episode: null, plutoId: DIAGNOSTIC_VOD_ID });
        result.pluto_id = DIAGNOSTIC_VOD_ID;
        result.content_kind = 'movie';
        result.items_inspected = 1;
      } else if (input.discover) {
        const discoveryProvider = createPlutoSourceProvider({
          id: 'pluto_discovery', enabled: true, baseUrl: input.baseUrl,
          bootUrl: input.bootUrl, timeoutMs: input.timeoutMs,
          mediaMap: [], http: client,
        });
        provider = discoveryProvider;
        const discovered = await discoveryProvider.discoverPublicItem({
          maxItems: 20,
          onStage: (stage) => {
            if (stage === 'boot') result.boot_ok = true;
          },
        });
        result.discovery_endpoint_type = discovered.endpointType;
        result.response_bytes_read = discovered.responseBytes;
        result.items_inspected = discovered.itemsChecked;
        result.pluto_id = discovered.plutoId;
        result.content_kind = discovered.contentKind;
        if (!discovered.plutoId) {
          result.status = 'no_public_item';
          mapping = null;
        } else {
          const mappedType = discovered.contentKind === 'episode' ? 'episode' : 'movie';
          mapping = Object.freeze({ ...input, contentType: mappedType,
            tmdbId: 1, season: mappedType === 'episode' ? 1 : null,
            episode: mappedType === 'episode' ? 1 : null,
            plutoId: discovered.plutoId });
        }
      } else {
        result.pluto_id = input.plutoId;
        result.content_kind = input.contentType;
        result.season = input.season;
        result.episode = input.episode;
      }
      if (mapping) {
        provider ||= createPlutoSourceProvider({
          id: 'pluto_probe', enabled: true, baseUrl: mapping.baseUrl,
          bootUrl: mapping.bootUrl, timeoutMs: input.timeoutMs,
          mediaMap: [{ contentType: mapping.contentType, tmdbId: mapping.tmdbId,
            ...(mapping.contentType === 'episode'
              ? { season: mapping.season, episode: mapping.episode } : {}),
            plutoId: mapping.plutoId }],
          http: client,
        });
        const candidates = await provider.getSources({
          contentType: mapping.contentType,
          contentId: 'pluto-probe',
          tmdbId: mapping.tmdbId,
          title: 'Pluto probe',
          season: mapping.season,
          episode: mapping.episode,
        }, { diagnosticSessionPlayback: input.discover === true,
          diagnosticExactItem: input.episodeDiscover === true,
          temporaryPlutoId: input.discover || input.episodeDiscover
            ? mapping.plutoId : undefined });
        result.boot_ok = true;
        result.hls_found = candidates.length > 0;
        result.requests_with_cached_boot = input.discover ? null : requestCounts.exactItem;
        result.episode_found = mapping.contentType === 'episode' && candidates.length > 0;
        result.exact_episode_id = result.episode_found && requestCounts.exactItem === 1;
        if (candidates.length) {
          result.session_requirement = new URL(candidates[0].url).search
            ? 'url_temporal' : 'none';
          result.temporary_url = candidates[0].urlSensitivity === 'temporary_signed';
          result.expiry_detected = typeof candidates[0].expiresAt === 'string';
          result.remaining_lifetime_seconds = result.expiry_detected
            ? Math.max(0, Math.floor((new Date(candidates[0].expiresAt).getTime() - clock()) / 1000))
            : null;
        }
        if (candidates.length) {
          const direct = createDirectHlsResolver({ httpClient: client,
            timeoutMs: input.timeoutMs });
          const engine = createResolverEngine({
            registry: createResolverRegistry([direct]),
            timeoutMs: input.timeoutMs,
            maxStreams: 1,
          });
          const resolved = await engine.resolve({
            mediaContext: { contentType: mapping.contentType, contentId: 'pluto-probe',
              tmdbId: mapping.tmdbId, title: 'Pluto probe',
              season: mapping.season, episode: mapping.episode },
            candidates,
          });
          const stream = resolved.streams[0] || null;
          result.hls_valid = stream?.validated === true;
          Object.assign(result, safeHlsSummary(stream));
        }
        result.status = result.hls_valid ? 'ready' : result.hls_found ? 'invalid' : 'no_hls';
      }
    } catch (error) {
      const code = String(error?.code || '');
      result.status = /TIMEOUT/.test(code) ? 'timeout'
        : /ABORT|UNSAFE/.test(code) ? 'rejected'
          : /HTTP|CONNECTION|DNS/.test(code) ? 'unreachable' : 'failed';
    } finally {
      result.catalog_requests = requestCounts.catalog;
      result.search_requests = requestCounts.search;
      result.series_requests = requestCounts.series;
      result.season_requests = requestCounts.season;
      result.latency_ms = Math.max(0, clock() - startedAt);
    }
    return Object.freeze(result);
  };
  return Object.freeze({ run });
};

const safeOutput = (result) => Object.freeze({
  boot_ok: result.boot_ok,
  discovery_endpoint_type: result.discovery_endpoint_type,
  response_bytes_read: result.response_bytes_read,
  items_inspected: result.items_inspected,
  pluto_id: result.pluto_id,
  content_kind: result.content_kind,
  show_identifier: result.show_identifier,
  season: result.season,
  episode: result.episode,
  episode_found: result.episode_found,
  exact_episode_id: result.exact_episode_id,
  exact_item_request: result.exact_item_request,
  requests_with_cached_boot: result.requests_with_cached_boot,
  catalog_requests: result.catalog_requests,
  search_requests: result.search_requests,
  series_requests: result.series_requests,
  season_requests: result.season_requests,
  browser_requests: result.browser_requests,
  hls_found: result.hls_found,
  hls_valid: result.hls_valid,
  variants: result.variants,
  audio: result.audio,
  subtitles: result.subtitles,
  session_requirement: result.session_requirement,
  temporary_url: result.temporary_url,
  expiry_detected: result.expiry_detected,
  remaining_lifetime_seconds: result.remaining_lifetime_seconds,
  latency_ms: result.latency_ms,
});

const formatText = (result) => Object.entries(safeOutput(result))
  .map(([name, value]) => `${name}=${value ?? ''}`).join('\n');

const formatJson = (result) => JSON.stringify(safeOutput(result));

module.exports = {
  DIAGNOSTIC_SERIES_ID,
  DIAGNOSTIC_VOD_ID,
  createPlutoProbe,
  formatJson,
  formatText,
  parseArgs,
};
