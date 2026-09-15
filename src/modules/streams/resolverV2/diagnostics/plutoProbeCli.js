'use strict';

const { createSafeHttpClient } = require('../../http/safeHttpClient');
const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');
const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createPlutoSourceProvider, DEFAULT_BASE_URL, DEFAULT_BOOT_URL } =
  require('../providers/plutoSourceProvider');

const BOOLEAN_FLAGS = new Set(['--json', '--discover']);
const VALUE_FLAGS = new Set([
  '--content-type', '--tmdb-id', '--season', '--episode', '--pluto-id',
  '--base-url', '--boot-url', '--timeout-ms',
]);

const parseArgs = (argv = []) => {
  const options = { json: false, discover: false, contentType: 'movie', baseUrl: DEFAULT_BASE_URL,
    bootUrl: DEFAULT_BOOT_URL, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      options[flag.slice(2)] = true;
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
  if (!['movie', 'episode'].includes(options.contentType) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 ||
      (options.discover && hasExplicitMapping) ||
      (!options.discover && (!Number.isInteger(tmdbId) || tmdbId < 1 ||
        typeof options.plutoId !== 'string' || !options.plutoId.trim())) ||
      (!options.discover && options.contentType === 'episode' &&
        (!Number.isInteger(season) || season < 0 ||
          !Number.isInteger(episode) || episode < 1))) {
    return { ok: false, json: options.json };
  }
  return { ok: true, json: options.json, value: Object.freeze({
    discover: options.discover,
    contentType: options.contentType,
    tmdbId: options.discover ? null : tmdbId,
    season: options.discover ? null : season,
    episode: options.discover ? null : episode,
    plutoId: options.discover ? null : options.plutoId.trim(),
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
      discovery_endpoint_type: input.discover ? 'boot_epg' : 'explicit_mapping',
      response_bytes_read: 0,
      items_inspected: 0,
      pluto_id: null,
      content_kind: null,
      hls_found: false,
      hls_valid: false,
      variants: 0,
      audio: 0,
      subtitles: 0,
      session_requirement: 'unknown',
      latency_ms: 0,
    };
    try {
      const client = httpClient || createSafeHttpClient({ timeoutMs: input.timeoutMs });
      let mapping = input;
      let provider = null;
      if (input.discover) {
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
          temporaryPlutoId: input.discover ? mapping.plutoId : undefined });
        result.boot_ok = true;
        result.hls_found = candidates.length > 0;
        if (candidates.length) {
          result.session_requirement = new URL(candidates[0].url).search
            ? 'url_temporal' : 'none';
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
  hls_found: result.hls_found,
  hls_valid: result.hls_valid,
  variants: result.variants,
  audio: result.audio,
  subtitles: result.subtitles,
  session_requirement: result.session_requirement,
  latency_ms: result.latency_ms,
});

const formatText = (result) => Object.entries(safeOutput(result))
  .map(([name, value]) => `${name}=${value ?? ''}`).join('\n');

const formatJson = (result) => JSON.stringify(safeOutput(result));

module.exports = {
  createPlutoProbe,
  formatJson,
  formatText,
  parseArgs,
};
