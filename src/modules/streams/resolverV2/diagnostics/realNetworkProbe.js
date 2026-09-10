'use strict';

const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');
const { createStreamRanker } = require('../ranking/streamRanker');
const { createPrimaryAcceptanceGate } = require('../primaryAcceptanceGate');
const { createPeerTubeSourceProvider } = require('../providers/peerTubeSourceProvider');
const { OFFICIAL_PROBES, getOfficialProbe } = require('./officialProbeCatalog');

const PROBE_STATUSES = Object.freeze([
  'ready', 'invalid', 'timeout', 'unreachable', 'rejected', 'failed',
]);
const probeError = (code) => Object.assign(new Error(code), { code });
const safeCount = (value) => Number.isInteger(value) && value >= 0 ? value : 0;

const summary = (id, status, startedAt, now, values = {}) => Object.freeze({
  id,
  status: PROBE_STATUSES.includes(status) ? status : 'failed',
  http: Number.isInteger(values.http) ? values.http : null,
  protocol: ['hls', 'unknown'].includes(values.protocol) ? values.protocol : 'unknown',
  isHls: values.isHls === true,
  isMaster: values.isMaster === true,
  isMediaPlaylist: values.isMediaPlaylist === true,
  variantCount: safeCount(values.variantCount),
  audioTrackCount: safeCount(values.audioTrackCount),
  subtitleTrackCount: safeCount(values.subtitleTrackCount),
  validated: values.validated === true,
  acceptanceCode: typeof values.acceptanceCode === 'string' &&
    /^PRIMARY_[A-Z0-9_]{1,63}$/.test(values.acceptanceCode)
    ? values.acceptanceCode : 'PRIMARY_NO_STREAM',
  latencyMs: Math.max(0, now() - startedAt),
  manifestBytes: Number.isInteger(values.manifestBytes) && values.manifestBytes >= 0
    ? values.manifestBytes : null,
});

const createRealNetworkProbe = ({
  httpClient,
  probes = OFFICIAL_PROBES,
  timeoutMs = 15_000,
  now = Date.now,
} = {}) => {
  if (!httpClient || typeof httpClient.get !== 'function' ||
      !Array.isArray(probes) || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 || timeoutMs > 30_000 || typeof now !== 'function') {
    throw probeError('NETWORK_PROBE_INVALID_CONFIG');
  }
  const allowed = new Map(probes.filter((item) => item?.enabled === true)
    .map((item) => [item.id, item]));
  const remainingMs = (startedAt) => {
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining < 1) throw probeError('NETWORK_PROBE_TIMEOUT');
    return remaining;
  };

  const resolveCandidates = async (probe, candidates, signal, startedAt) => {
    const resolver = createDirectHlsResolver({ httpClient,
      timeoutMs: remainingMs(startedAt) });
    const engine = createResolverEngine({
      registry: createResolverRegistry([resolver]), timeoutMs, maxStreams: 8,
    });
    const result = await engine.resolve({
      mediaContext: { contentType: 'movie', contentId: 'network-probe',
        tmdbId: 1, title: 'Network probe' },
      candidates,
      signal,
    });
    const selection = createStreamRanker().selectBest(result.streams);
    const gate = createPrimaryAcceptanceGate().evaluate(selection.selected);
    const stream = selection.selected;
    const info = stream?.hlsInfo || {};
    const failedCode = result.attempts?.find(({ outcome }) => outcome === 'failed')?.errorCode;
    const emptyStatus = /UNSAFE|ABORT/.test(failedCode || '') ? 'rejected'
      : /TIMEOUT/.test(failedCode || '') ? 'timeout'
        : /CONNECTION|DNS/.test(failedCode || '') ? 'unreachable' : 'invalid';
    return summary(probe.id, gate.accepted ? 'ready'
      : stream ? 'rejected' : emptyStatus, startedAt, now, {
      http: stream ? 200 : null,
      protocol: stream?.protocol || 'unknown',
      isHls: info.isHls, isMaster: info.isMaster,
      isMediaPlaylist: info.isMediaPlaylist,
      variantCount: info.variants?.length,
      audioTrackCount: info.audioTracks?.length,
      subtitleTrackCount: info.subtitleTracks?.length,
      validated: stream?.validated,
      acceptanceCode: gate.code,
    });
  };

  const peerTubeCandidates = async (probe, signal, startedAt) => {
    const listing = new URL('/api/v1/videos?count=10&start=0&sort=-publishedAt', probe.url);
    const response = await httpClient.get(listing.href, {
      headers: { accept: 'application/json' },
      timeoutMs: remainingMs(startedAt),
      maxBytes: 512 * 1024, maxRedirects: 3, signal,
    });
    if (!response.ok) throw probeError('NETWORK_PROBE_HTTP_ERROR');
    let payload;
    try { payload = JSON.parse(response.body.toString('utf8')); } catch {
      throw probeError('NETWORK_PROBE_INVALID_RESPONSE');
    }
    const videos = Array.isArray(payload?.data) ? payload.data.slice(0, 10) : [];
    for (const video of videos) {
      if (remainingMs(startedAt) < 100) throw probeError('NETWORK_PROBE_TIMEOUT');
      const videoId = String(video?.uuid || video?.shortUUID || video?.id || '');
      if (!videoId) continue;
      const provider = createPeerTubeSourceProvider({
        id: 'peertube_probe', enabled: true, baseUrl: probe.url, http: httpClient,
        timeoutMs: Math.min(10_000, remainingMs(startedAt)),
        mediaMap: [{ contentType: 'movie', tmdbId: 1, videoId }],
      });
      const candidates = await provider.getSources(
        { contentType: 'movie', tmdbId: 1 }, { http: httpClient, signal });
      if (candidates.length) return candidates;
    }
    return [];
  };

  const run = async (id, { signal } = {}) => {
    const startedAt = now();
    const probe = allowed.get(id);
    if (!probe) return summary('unknown', 'failed', startedAt, now);
    try {
      const candidates = probe.kind === 'peertube_discovery'
        ? await peerTubeCandidates(probe, signal, startedAt)
        : [{ providerId: `official_${probe.id}`, url: probe.url, headers: {},
          qualityHint: 'auto', metadata: { sourceType: 'official_probe' } }];
      if (!candidates.length) return summary(probe.id, 'invalid', startedAt, now);
      return await resolveCandidates(probe, candidates, signal, startedAt);
    } catch (error) {
      const code = String(error?.code || '');
      const status = /TIMEOUT/.test(code) ? 'timeout'
        : /UNSAFE|ABORT/.test(code) ? 'rejected'
          : /CONNECTION|DNS/.test(code) ? 'unreachable' : 'failed';
      return summary(probe.id, status, startedAt, now);
    }
  };
  const runAll = async (options) => {
    const output = [];
    for (const probe of allowed.values()) output.push(await run(probe.id, options));
    return output;
  };
  return Object.freeze({ run, runAll, list: () => Object.freeze([...allowed.keys()]) });
};

module.exports = { PROBE_STATUSES, createRealNetworkProbe };
