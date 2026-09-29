'use strict';

const { createSafeHttpClient, bodyText } = require('./http/safeHttpClient');
const { createStreamStore } = require('../../db/streams.queries');
const { isPlaybackTransportConfigured, playbackHeadersOrNull } = require('./playbackHeaders');
const { createHlsProxyTokenCodec, HLS_PROXY_MODES, validProxyMode } =
  require('./hlsProxyToken');
const { rewriteHlsManifest } = require('./hlsManifestRewriter');

const SAFE_RESPONSE_HEADERS = Object.freeze([
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
]);
const HLS_CONTENT_TYPE = /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i;
const proxyError = (statusCode = 404) => Object.assign(new Error('HLS proxy unavailable'), {
  code: 'HLS_PROXY_UNAVAILABLE', statusCode,
});
const validRange = (value) => value === undefined ||
  /^bytes=(?:\d+-\d*|\d*-\d+)$/.test(value);

const createHlsProxy = ({
  enabled = false,
  secret = '',
  publicBaseUrl = '',
  tokenTtlSeconds = 600,
  timeoutMs = 12_000,
  maxManifestBytes = 256 * 1024,
  temporaryUrlSafetySeconds = 60,
  store = createStreamStore(),
  httpClient = createSafeHttpClient({ timeoutMs }),
  tokenCodec,
} = {}) => {
  let codec = tokenCodec || null;
  const validConfiguration = tokenCodec ? enabled === true : isPlaybackTransportConfigured({
    enabled, secret, publicBaseUrl,
  });
  if (!codec && validConfiguration) {
    codec = createHlsProxyTokenCodec({ secret, ttlSeconds: tokenTtlSeconds });
  }
  const available = validConfiguration && Boolean(codec) &&
    store && typeof store.findProxyStream === 'function' &&
    httpClient && typeof httpClient.get === 'function' && typeof httpClient.stream === 'function';
  const toPublicUrl = (token) => {
    const path = `/stream-proxy/${token}`;
    if (!publicBaseUrl) return path;
    return new URL(path, publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`).toString();
  };
  const createPlaybackUrl = (stream, { mode = HLS_PROXY_MODES.FULL } = {}) => {
    if (!available || !stream?.id || !validProxyMode(mode)) return null;
    const headers = playbackHeadersOrNull(stream.playback_headers);
    if (!headers || Object.keys(headers).length === 0) return null;
    return toPublicUrl(codec.issue({ streamId: stream.id,
      targetUrl: stream.stream_url, kind: 'manifest', mode }));
  };
  const copyHeaders = (res, headers, { omitLength = false } = {}) => {
    for (const name of SAFE_RESPONSE_HEADERS) {
      if (omitLength && name === 'content-length') continue;
      const value = headers?.[name];
      if (typeof value === 'string') res.set(name, value);
    }
  };
  const handle = async (req, res, next) => {
    if (!available) return next(proxyError());
    const controller = new AbortController();
    let responseBody = null;
    let streaming = false;
    const abortUpstream = () => {
      if (!controller.signal.aborted) controller.abort();
      responseBody?.destroy();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) abortUpstream();
    };
    const cleanup = () => {
      req.removeListener('aborted', abortUpstream);
      res.removeListener('close', onResponseClose);
    };
    req.once('aborted', abortUpstream);
    res.once('close', onResponseClose);
    let payload;
    try {
      try { payload = codec.verify(req.params.token); } catch { return next(proxyError()); }
      const stream = await store.findProxyStream(payload.streamId,
        temporaryUrlSafetySeconds * 1000);
      const headers = playbackHeadersOrNull(stream?.playback_headers);
      if (!stream || !headers || Object.keys(headers).length === 0) return next(proxyError());
      const range = req.headers.range;
      if (!validRange(range)) return next(proxyError(416));
      const upstreamHeaders = { ...headers, ...(range ? { range } : {}) };
      if (payload.kind === 'manifest') {
        const response = await httpClient.get(payload.targetUrl, {
          headers: upstreamHeaders, timeoutMs, maxBytes: maxManifestBytes,
          signal: controller.signal,
        });
        if (!response.ok) return next(proxyError(response.status === 404 ? 404 : 502));
        const manifest = bodyText(response);
        const rewritten = rewriteHlsManifest(manifest, response.url, (targetUrl, kind) =>
          toPublicUrl(codec.issue({ streamId: payload.streamId, targetUrl, kind,
            mode: payload.mode })), { mode: payload.mode });
        copyHeaders(res, response.headers, { omitLength: true });
        res.type('application/vnd.apple.mpegurl');
        return res.status(200).send(rewritten);
      }
      const response = await httpClient.stream(payload.targetUrl, {
        headers: upstreamHeaders, timeoutMs, signal: controller.signal,
      });
      responseBody = response.body;
      if (!response.ok) {
        response.body.resume();
        return next(proxyError(response.status === 404 ? 404 : 502));
      }
      if (HLS_CONTENT_TYPE.test(response.headers?.['content-type'] || '')) {
        response.body.resume();
        return next(proxyError(502));
      }
      copyHeaders(res, response.headers);
      res.status(response.status);
      streaming = true;
      const finishStreaming = () => cleanup();
      response.body.once('end', finishStreaming);
      response.body.once('close', finishStreaming);
      response.body.once('error', () => { if (!res.headersSent) next(proxyError(502)); else res.destroy(); });
      return response.body.pipe(res);
    } catch {
      if (controller.signal.aborted) return undefined;
      return next(proxyError(502));
    } finally {
      if (!streaming) cleanup();
    }
  };
  return Object.freeze({ available, createPlaybackUrl, handle });
};

module.exports = { SAFE_RESPONSE_HEADERS, createHlsProxy, validRange };
