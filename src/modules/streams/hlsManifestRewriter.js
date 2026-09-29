'use strict';

const { HLS_PROXY_MODES, validProxyMode } = require('./hlsProxyToken');

const MANIFEST_ATTRIBUTE_TAGS = new Set([
  '#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-RENDITION-REPORT',
]);

const targetKind = (tag, target) => MANIFEST_ATTRIBUTE_TAGS.has(tag) ||
  /\.m3u8(?:$|[?#])/i.test(target) ? 'manifest' : 'resource';

const rewriteHlsManifest = (manifest, baseUrl, createProxyUrl,
  { mode = HLS_PROXY_MODES.FULL } = {}) => {
  if (typeof manifest !== 'string' || !manifest.trimStart().startsWith('#EXTM3U') ||
      typeof createProxyUrl !== 'function' || !validProxyMode(mode)) {
    throw new Error('HLS_PROXY_INVALID_MANIFEST');
  }
  let nextLineIsManifest = false;
  let nextLineIsSegment = false;
  const targetUrl = (uri) => {
    const target = new URL(uri, baseUrl);
    if (mode === HLS_PROXY_MODES.PLAYLISTS_ONLY &&
        (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)) {
      throw new Error('HLS_PROXY_INVALID_MANIFEST');
    }
    return target;
  };
  return manifest.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const kind = nextLineIsManifest || /\.m3u8(?:$|[?#])/i.test(trimmed)
        ? 'manifest' : 'resource';
      nextLineIsManifest = false;
      const isSegment = nextLineIsSegment;
      nextLineIsSegment = false;
      const target = targetUrl(trimmed);
      // Only a same-origin, explicitly marked MPEG-TS media segment is portable.
      // Unknown resources, keys, maps, and alternate playlists remain proxied.
      if (mode === HLS_PROXY_MODES.PLAYLISTS_ONLY && kind === 'resource' &&
          isSegment && target.pathname.toLowerCase().endsWith('.ts') &&
          target.origin === new URL(baseUrl).origin) return target.toString();
      return createProxyUrl(target.toString(), kind);
    }
    const tag = trimmed.split(':', 1)[0];
    nextLineIsManifest = tag === '#EXT-X-STREAM-INF';
    if (tag === '#EXTINF') nextLineIsSegment = true;
    return line.replace(/URI="([^"]+)"/g, (_match, uri) =>
      `URI="${createProxyUrl(targetUrl(uri).toString(), targetKind(tag, uri))}"`);
  }).join('\n');
};

module.exports = { rewriteHlsManifest };
