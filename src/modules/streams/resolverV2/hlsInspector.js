'use strict';

const emptyInspection = () => ({
  isHls: false,
  isMaster: false,
  isMediaPlaylist: false,
  variants: [],
  audioTracks: [],
  subtitleTracks: [],
});

const stripQuotedValue = (value) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
};

const parseAttributeList = (input) => {
  if (typeof input !== 'string') return {};
  const parts = [];
  let current = '';
  let quoted = false;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);

  const attributes = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toUpperCase();
    if (!key) continue;
    attributes[key] = stripQuotedValue(part.slice(separator + 1));
  }
  return attributes;
};

const numberOrNull = (value) => {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const yesNoOrNull = (value) => {
  if (typeof value !== 'string') return null;
  if (value.toUpperCase() === 'YES') return true;
  if (value.toUpperCase() === 'NO') return false;
  return null;
};

const normalizeLanguage = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const language = value.trim().toLowerCase().replace(/_/g, '-');
  if (/^(?:latino|latin|latam|spanish[- ](?:latin|latam)|es-(?:lat|latam|mx|us)|spa-lat)$/.test(language)) {
    return 'es-419';
  }
  return language;
};

const validHttpBase = (baseUrl) => {
  if (typeof baseUrl !== 'string') return null;
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

const resolveUri = (uri, baseUrl) => {
  if (typeof uri !== 'string') return null;
  const normalized = uri.trim();
  if (!normalized) return null;
  const base = validHttpBase(baseUrl);
  if (!base) return normalized;
  try {
    const resolved = new URL(normalized, base);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString() : normalized;
  } catch {
    return normalized;
  }
};

const parseResolution = (value) => {
  if (typeof value !== 'string') return { resolution: null, width: null, height: null };
  const match = value.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return { resolution: value.trim() || null, width: null, height: null };
  return {
    resolution: `${match[1]}x${match[2]}`,
    width: Number(match[1]),
    height: Number(match[2]),
  };
};

const mediaTrack = (attributes, baseUrl) => ({
  groupId: attributes['GROUP-ID'] || null,
  name: attributes.NAME || null,
  language: normalizeLanguage(attributes.LANGUAGE),
  default: yesNoOrNull(attributes.DEFAULT),
  autoselect: yesNoOrNull(attributes.AUTOSELECT),
  forced: yesNoOrNull(attributes.FORCED),
  uri: resolveUri(attributes.URI, baseUrl),
});

const inspectHlsManifest = (manifest, { baseUrl = null } = {}) => {
  const result = emptyInspection();
  if (typeof manifest !== 'string') return result;
  const lines = manifest.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
  const firstMeaningful = lines.find((line) => line.length > 0);
  if (firstMeaningful !== '#EXTM3U') return result;

  result.isHls = true;
  let hasMasterTag = false;
  let hasExtInf = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      hasMasterTag = true;
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      let uri = null;
      for (let candidateIndex = index + 1; candidateIndex < lines.length; candidateIndex += 1) {
        const candidate = lines[candidateIndex];
        if (!candidate) continue;
        if (candidate.startsWith('#')) break;
        uri = candidate;
        index = candidateIndex;
        break;
      }
      const resolution = parseResolution(attributes.RESOLUTION);
      result.variants.push({
        url: resolveUri(uri, baseUrl),
        bandwidth: numberOrNull(attributes.BANDWIDTH),
        averageBandwidth: numberOrNull(attributes['AVERAGE-BANDWIDTH']),
        resolution: resolution.resolution,
        width: resolution.width,
        height: resolution.height,
        codecs: attributes.CODECS || null,
        frameRate: numberOrNull(attributes['FRAME-RATE']),
        audioGroup: attributes.AUDIO || null,
        subtitleGroup: attributes.SUBTITLES || null,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      hasMasterTag = true;
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      const type = attributes.TYPE?.toUpperCase();
      if (type === 'AUDIO') result.audioTracks.push(mediaTrack(attributes, baseUrl));
      if (type === 'SUBTITLES') result.subtitleTracks.push(mediaTrack(attributes, baseUrl));
      continue;
    }

    if (line === '#EXTINF' || line.startsWith('#EXTINF:')) hasExtInf = true;
  }

  result.isMaster = hasMasterTag;
  result.isMediaPlaylist = hasExtInf && !hasMasterTag;
  return result;
};

module.exports = {
  inspectHlsManifest,
  parseAttributeList,
};
