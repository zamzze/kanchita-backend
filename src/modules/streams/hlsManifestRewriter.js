'use strict';

const MANIFEST_ATTRIBUTE_TAGS = new Set([
  '#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-RENDITION-REPORT',
]);

const targetKind = (tag, target) => MANIFEST_ATTRIBUTE_TAGS.has(tag) ||
  /\.m3u8(?:$|[?#])/i.test(target) ? 'manifest' : 'resource';

const rewriteHlsManifest = (manifest, baseUrl, createProxyUrl) => {
  if (typeof manifest !== 'string' || !manifest.trimStart().startsWith('#EXTM3U') ||
      typeof createProxyUrl !== 'function') throw new Error('HLS_PROXY_INVALID_MANIFEST');
  let nextLineIsManifest = false;
  return manifest.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const kind = nextLineIsManifest || /\.m3u8(?:$|[?#])/i.test(trimmed)
        ? 'manifest' : 'resource';
      nextLineIsManifest = false;
      return createProxyUrl(new URL(trimmed, baseUrl).toString(), kind);
    }
    const tag = trimmed.split(':', 1)[0];
    nextLineIsManifest = tag === '#EXT-X-STREAM-INF';
    return line.replace(/URI="([^"]+)"/g, (_match, uri) =>
      `URI="${createProxyUrl(new URL(uri, baseUrl).toString(), targetKind(tag, uri))}"`);
  }).join('\n');
};

module.exports = { rewriteHlsManifest };
