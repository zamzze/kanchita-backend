'use strict';

const { createSafeHttpClient } = require('../../http/safeHttpClient');
const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');
const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createPlutoSourceProvider, DEFAULT_BASE_URL, DEFAULT_BOOT_URL } =
  require('../providers/plutoSourceProvider');

const BOOLEAN_FLAGS = new Set(['--json']);
const VALUE_FLAGS = new Set([
  '--content-type', '--tmdb-id', '--season', '--episode', '--pluto-id',
  '--base-url', '--boot-url', '--timeout-ms',
]);

const parseArgs = (argv = []) => {
  const options = { json: false, contentType: 'movie', baseUrl: DEFAULT_BASE_URL,
    bootUrl: DEFAULT_BOOT_URL, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      options.json = true;
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
  if (!['movie', 'episode'].includes(options.contentType) ||
      !Number.isInteger(tmdbId) || tmdbId < 1 ||
      typeof options.plutoId !== 'string' || !options.plutoId.trim() ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 ||
      (options.contentType === 'episode' &&
        (!Number.isInteger(season) || season < 0 ||
          !Number.isInteger(episode) || episode < 1))) {
    return { ok: false, json: options.json };
  }
  return { ok: true, json: options.json, value: Object.freeze({
    contentType: options.contentType,
    tmdbId,
    season,
    episode,
    plutoId: options.plutoId.trim(),
    baseUrl: options.baseUrl,
    bootUrl: options.bootUrl,
    timeoutMs,
  }) };
};

const safeHlsSummary = (stream) => {
  const info = stream?.hlsInfo || {};
  return Object.freeze({
    variants: Array.isArray(info.variants) ? info.variants.length : 0,
    audio: Array.isArray(info.audioTracks)
      ? info.audioTracks.map((track) => track.language).filter(Boolean).slice(0, 16) : [],
    subtitles: Array.isArray(info.subtitleTracks)
      ? info.subtitleTracks.map((track) => track.language).filter(Boolean).slice(0, 16) : [],
  });
};

const createPlutoProbe = ({ httpClient, clock = Date.now } = {}) => {
  const run = async (input) => {
    const startedAt = clock();
    const result = {
      status: 'failed',
      boot_ok: false,
      catalog_ok: false,
      hls_found: false,
      hls_valid: false,
      variants: 0,
      audio: [],
      subtitles: [],
      latency: 0,
    };
    try {
      const client = httpClient || createSafeHttpClient({ timeoutMs: input.timeoutMs });
      const provider = createPlutoSourceProvider({
        id: 'pluto_probe',
        enabled: true,
        baseUrl: input.baseUrl,
        bootUrl: input.bootUrl,
        timeoutMs: Math.min(input.timeoutMs, 10000),
        mediaMap: [{ contentType: input.contentType, tmdbId: input.tmdbId,
          ...(input.contentType === 'episode'
            ? { season: input.season, episode: input.episode } : {}),
          plutoId: input.plutoId }],
        http: client,
      });
      const candidates = await provider.getSources({
        contentType: input.contentType,
        contentId: 'pluto-probe',
        tmdbId: input.tmdbId,
        title: 'Pluto probe',
        season: input.season,
        episode: input.episode,
      });
      result.boot_ok = true;
      result.catalog_ok = true;
      result.hls_found = candidates.length > 0;
      if (candidates.length) {
        const direct = createDirectHlsResolver({ httpClient: client,
          timeoutMs: input.timeoutMs });
        const engine = createResolverEngine({
          registry: createResolverRegistry([direct]),
          timeoutMs: input.timeoutMs,
          maxStreams: 1,
        });
        const resolved = await engine.resolve({
          mediaContext: { contentType: input.contentType, contentId: 'pluto-probe',
            tmdbId: input.tmdbId, title: 'Pluto probe',
            season: input.season, episode: input.episode },
          candidates,
        });
        const stream = resolved.streams[0] || null;
        result.hls_valid = stream?.validated === true;
        Object.assign(result, safeHlsSummary(stream));
      }
      result.status = result.hls_valid ? 'ready' : result.hls_found ? 'invalid' : 'no_hls';
    } catch (error) {
      const code = String(error?.code || '');
      result.status = /TIMEOUT/.test(code) ? 'timeout'
        : /ABORT|UNSAFE/.test(code) ? 'rejected'
          : /HTTP|CONNECTION|DNS/.test(code) ? 'unreachable' : 'failed';
    } finally {
      result.latency = Math.max(0, clock() - startedAt);
    }
    return Object.freeze(result);
  };
  return Object.freeze({ run });
};

const formatText = (result) => [
  `status=${result.status}`,
  `boot_ok=${result.boot_ok}`,
  `catalog_ok=${result.catalog_ok}`,
  `hls_found=${result.hls_found}`,
  `hls_valid=${result.hls_valid}`,
  `variants=${result.variants}`,
  `audio=${result.audio.join(',')}`,
  `subtitles=${result.subtitles.join(',')}`,
  `latency=${result.latency}`,
].join('\n');

const formatJson = (result) => JSON.stringify(result);

module.exports = {
  createPlutoProbe,
  formatJson,
  formatText,
  parseArgs,
};
