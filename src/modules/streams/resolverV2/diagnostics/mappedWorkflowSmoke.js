'use strict';

const { createResolverRegistry } = require('../resolverRegistry');
const { createResolverEngine } = require('../resolverEngine');
const { createDirectHlsResolver } = require('../resolvers/directHlsResolver');
const { createHttpWorkflowSourceProvider } =
  require('../providers/httpWorkflowSourceProvider');
const { createMappedSourceProviderAdapter } =
  require('../providers/mappedSourceProviderAdapter');
const { normalizeBaseUrl } = require('../providers/configuredHttpSourceProvider');

const VIDEO_ID = /^(?:[1-9]\d{0,15}|[A-Za-z0-9_-]{6,128})$/;
const PROVIDER_ID = 'peertube_workflow';
const DIAGNOSTIC_TMDB_ID = 2_147_000_001;
const API_PATTERN = '/api/v1/videos/{video-id}';
const STATUSES = Object.freeze([
  'VIDEO_NOT_FOUND', 'VIDEO_NOT_PUBLIC', 'NO_PUBLIC_HLS', 'WORKFLOW_EMPTY',
  'WORKFLOW_HTTP_ERROR', 'RESOLUTION_EMPTY', 'RESOLUTION_FAILED', 'RESOLUTION_READY',
]);

const safeCode = (error) => typeof error?.code === 'string' &&
  /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN_ERROR';

const safeMediaLocation = (value) => {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch { return null; }
};

const parseMappedWorkflowSmokeArgs = (argv) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  const values = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') { values.json = true; continue; }
    if (!['--base-url', '--video-id'].includes(argument) || index + 1 >= argv.length ||
        values[argument.slice(2)] !== undefined) return { ok: false, json: values.json };
    values[argument.slice(2)] = argv[index += 1];
  }
  const base = normalizeBaseUrl(values['base-url']);
  const videoId = typeof values['video-id'] === 'string' ? values['video-id'].trim() : '';
  if (!base || !VIDEO_ID.test(videoId)) return { ok: false, json: values.json };
  return Object.freeze({ ok: true, json: values.json, baseUrl: base.href, videoId });
};

const createTrackedHttpClient = (httpClient, onResponse) => {
  const requests = [];
  const invoke = async (method, url, options, call) => {
    requests.push(method);
    const response = await call(url, options);
    onResponse?.(method, url, response);
    return response;
  };
  return {
    requests,
    request: (method, url, options) => invoke(method, url, options,
      (target, requestOptions) => httpClient.request(method, target, requestOptions)),
    get: (url, options) => invoke('GET', url, options,
      (target, requestOptions) => httpClient.get(target, requestOptions)),
    head: (url, options) => invoke('HEAD', url, options,
      (target, requestOptions) => httpClient.head(target, requestOptions)),
  };
};

const inspectApiResponse = (method, requestUrl, response, state) => {
  let url;
  try { url = new URL(requestUrl); } catch { return; }
  if (method !== 'GET' || !url.pathname.startsWith('/api/v1/videos/')) return;
  state.apiStatus = response?.status ?? null;
  state.apiRequestCount += 1;
  if (!response?.ok || !Buffer.isBuffer(response.body)) return;
  try {
    const payload = JSON.parse(response.body.toString('utf8'));
    state.publicHlsPresent = Array.isArray(payload?.streamingPlaylists) &&
      payload.streamingPlaylists.some((entry) => {
        try {
          const playlist = new URL(entry?.playlistUrl);
          return ['http:', 'https:'].includes(playlist.protocol) &&
            !playlist.username && !playlist.password;
        } catch { return false; }
      });
  } catch { state.validJson = false; }
};

const createMappedWorkflowSmoke = ({ httpClient, timeoutMs = 10_000, now = Date.now } = {}) => {
  if (!httpClient || typeof httpClient.request !== 'function' ||
      typeof httpClient.get !== 'function' || typeof httpClient.head !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      typeof now !== 'function') throw new Error('MAPPED_WORKFLOW_SMOKE_INVALID_CONFIG');

  const run = async ({ baseUrl, videoId, signal } = {}) => {
    const parsed = parseMappedWorkflowSmokeArgs(['--base-url', baseUrl, '--video-id', videoId]);
    if (!parsed.ok) throw new Error('MAPPED_WORKFLOW_SMOKE_INVALID_INPUT');
    const startedAt = now();
    const state = { apiStatus: null, apiRequestCount: 0, publicHlsPresent: false,
      validJson: true };
    const tracked = createTrackedHttpClient(httpClient,
      (method, url, response) => inspectApiResponse(method, url, response, state));
    const workflowProvider = createHttpWorkflowSourceProvider({
      id: PROVIDER_ID,
      enabled: true,
      baseUrl: parsed.baseUrl,
      http: tracked,
      timeoutMs,
      maxCandidates: 1,
      workflow: [
        { type: 'request', method: 'GET', path: '/api/v1/videos/{externalId}',
          headers: { accept: 'application/json' }, saveAs: 'video' },
        { type: 'extract', from: 'video', parser: 'json',
          path: 'streamingPlaylists.0.playlistUrl', saveAs: 'playlistUrl' },
        { type: 'emit', url: '{playlistUrl}', qualityHint: 'auto',
          metadata: { sourceType: 'peertube_public_diagnostic' } },
      ],
    });
    const providerMediaRef = Object.freeze({
      mappingId: 1, providerId: PROVIDER_ID, region: 'global', contentType: 'movie',
      tmdbId: DIAGNOSTIC_TMDB_ID, externalId: parsed.videoId, seasonNumber: null,
      episodeNumber: null, providerTitle: null, providerSlug: null,
      matchMethod: 'diagnostic_explicit', matchConfidence: 100,
      metadata: Object.freeze({}), lastVerifiedAt: null,
    });
    const adapter = createMappedSourceProviderAdapter({
      provider: workflowProvider,
      mappingResolver: Object.freeze({ resolve: async () => Object.freeze([providerMediaRef]) }),
      region: 'global', maxMappingAttempts: 1,
    });
    const mediaContext = Object.freeze({
      contentType: 'movie', contentId: 'peertube-public-diagnostic',
      tmdbId: DIAGNOSTIC_TMDB_ID, title: 'PeerTube public diagnostic',
    });
    let candidates;
    try {
      candidates = await adapter.getSources(mediaContext, { signal });
    } catch (error) {
      const status = state.apiStatus === 404 ? 'VIDEO_NOT_FOUND'
        : [401, 403].includes(state.apiStatus) ? 'VIDEO_NOT_PUBLIC' : 'WORKFLOW_HTTP_ERROR';
      return Object.freeze({ status, provider: PROVIDER_ID, mappingResolved: true,
        candidateCount: 0, protocol: null, validated: false, quality: null,
        mediaLocation: null, apiPattern: API_PATTERN, apiRequestCount: state.apiRequestCount,
        hlsRequestCount: 0, requestCount: tracked.requests.length,
        errorCode: safeCode(error), durationMs: Math.max(0, now() - startedAt) });
    }
    if (candidates.length === 0) {
      const status = state.apiStatus === 404 ? 'VIDEO_NOT_FOUND'
        : [401, 403].includes(state.apiStatus) ? 'VIDEO_NOT_PUBLIC'
          : state.apiStatus === 200 && state.validJson && !state.publicHlsPresent
            ? 'NO_PUBLIC_HLS' : 'WORKFLOW_EMPTY';
      return Object.freeze({ status, provider: PROVIDER_ID, mappingResolved: true,
        candidateCount: 0, protocol: null, validated: false, quality: null,
        mediaLocation: null, apiPattern: API_PATTERN, apiRequestCount: state.apiRequestCount,
        hlsRequestCount: 0, requestCount: tracked.requests.length,
        durationMs: Math.max(0, now() - startedAt) });
    }
    const directResolver = createDirectHlsResolver({ httpClient: tracked, timeoutMs });
    const engine = createResolverEngine({
      registry: createResolverRegistry([directResolver]), timeoutMs, maxStreams: 1,
    });
    let resolution;
    try {
      resolution = await engine.resolve({ mediaContext, candidates, signal });
    } catch (error) {
      return Object.freeze({ status: 'RESOLUTION_FAILED', provider: PROVIDER_ID,
        mappingResolved: true, candidateCount: candidates.length, protocol: null,
        validated: false, quality: null, mediaLocation: null, apiPattern: API_PATTERN,
        apiRequestCount: state.apiRequestCount,
        hlsRequestCount: tracked.requests.length - state.apiRequestCount,
        requestCount: tracked.requests.length, errorCode: safeCode(error),
        durationMs: Math.max(0, now() - startedAt) });
    }
    const stream = resolution.streams[0] || null;
    const failedAttempt = resolution.attempts.find(({ outcome }) => outcome === 'failed');
    return Object.freeze({ status: stream ? 'RESOLUTION_READY'
      : failedAttempt ? 'RESOLUTION_FAILED' : 'RESOLUTION_EMPTY',
      provider: PROVIDER_ID, mappingResolved: true, candidateCount: candidates.length,
      protocol: stream?.protocol || null, validated: stream?.validated === true,
      quality: stream?.quality || null, mediaLocation: safeMediaLocation(stream?.url),
      apiPattern: API_PATTERN, apiRequestCount: state.apiRequestCount,
      hlsRequestCount: tracked.requests.length - state.apiRequestCount,
      requestCount: tracked.requests.length,
      ...(failedAttempt?.errorCode ? { errorCode: failedAttempt.errorCode } : {}),
      durationMs: Math.max(0, now() - startedAt) });
  };
  return Object.freeze({ run });
};

const formatMappedWorkflowSmoke = (result, json = false) => {
  if (json) return JSON.stringify(result);
  return Object.entries(result).map(([key, value]) => `${key}=${value ?? 'null'}`).join('\n');
};

module.exports = {
  API_PATTERN,
  DIAGNOSTIC_TMDB_ID,
  PROVIDER_ID,
  STATUSES,
  createMappedWorkflowSmoke,
  formatMappedWorkflowSmoke,
  parseMappedWorkflowSmokeArgs,
  safeMediaLocation,
};
