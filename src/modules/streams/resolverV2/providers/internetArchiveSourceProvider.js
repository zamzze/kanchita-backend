'use strict';

const { normalizeEmbedCandidate } = require('../resolverContracts');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MP4_FORMAT = /\b(?:MPEG4|MP4)\b/i;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const MAX_FILES = 128;
const MAX_METADATA_BYTES = 512 * 1024;
const error = (code) => Object.assign(new Error(code), { code });

const openLicense = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== 'creativecommons.org' ||
        url.username || url.password || url.search || url.hash ||
        !(/^\/licenses\/(?:by|by-sa)\/(?:3\.0|4\.0)(?:\/[a-z]{2})?\/?$/.test(url.pathname) ||
          /^\/publicdomain\/zero\/1\.0\/?$/.test(url.pathname))) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch { return null; }
};

const safeFilename = (value) => typeof value === 'string' && value.length <= 512 &&
  value.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !/[\\?#\u0000-\u001f\u007f]/.test(part));
const canonicalFileUrl = (base, itemId, filename) => {
  if (!ITEM_ID.test(itemId) || itemId.includes('..') || !safeFilename(filename)) return null;
  const encodedName = filename.split('/').map(encodeURIComponent).join('/');
  return new URL(`/download/${encodeURIComponent(itemId)}/${encodedName}`, base).toString();
};
const numericField = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const qualityFromHeight = (height) =>
  [2160, 1080, 720, 480, 360, 240].includes(height) ? `${height}p` : null;

const selectMp4Files = (files, maxCandidates) => {
  if (!Array.isArray(files) || files.length > MAX_FILES) return [];
  const seen = new Set();
  return files.filter((file) => file && typeof file === 'object' && !Array.isArray(file) &&
      safeFilename(file.name) && file.name.toLowerCase().endsWith('.mp4') &&
      typeof file.format === 'string' && file.format.length <= 128 &&
      MP4_FORMAT.test(file.format) &&
      (file.mime === undefined || typeof file.mime === 'string' && file.mime.length <= 128) &&
      ['original', 'derivative'].includes(file.source) &&
      !/(?:^|[._-])(?:thumb|preview|sample|trailer)(?:[._-]|$)/i.test(file.name) &&
      numericField(file.size) >= 1024 && !seen.has(file.name) && seen.add(file.name))
    .sort((left, right) => (numericField(right.height) || 0) -
        (numericField(left.height) || 0) ||
      (numericField(right.width) || 0) - (numericField(left.width) || 0) ||
      Number(right.source === 'original') - Number(left.source === 'original') ||
      (numericField(right.size) || 0) - (numericField(left.size) || 0) ||
      left.name.localeCompare(right.name, 'en'))
    .slice(0, maxCandidates);
};

const createInternetArchiveSourceProvider = ({
  id = 'internet_archive', enabled = false, priority = 100,
  baseUrl = 'https://archive.org', http, timeoutMs = 3_000,
  maxCandidates = 3, supportsMovies = true, supportsEpisodes = false,
} = {}) => {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) || typeof enabled !== 'boolean' ||
      !Number.isInteger(priority) || !base ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 8 ||
      typeof supportsMovies !== 'boolean' || typeof supportsEpisodes !== 'boolean') {
    throw error('SOURCE_ARCHIVE_INVALID_CONFIG');
  }
  const getSources = async (mediaContext, runtime = {}) => {
    if (!enabled) return [];
    const ref = runtime.providerMediaRef;
    if (!ref || ref.providerId !== id || ref.contentType !== mediaContext?.contentType ||
        ref.tmdbId !== mediaContext.tmdbId ||
        (mediaContext.contentType === 'movie' && !supportsMovies) ||
        (mediaContext.contentType === 'episode' && !supportsEpisodes) ||
        (mediaContext.contentType === 'episode' &&
          (ref.seasonNumber !== mediaContext.season ||
            ref.episodeNumber !== mediaContext.episode)) ||
        typeof ref.externalId !== 'string' || !ITEM_ID.test(ref.externalId) ||
        ref.externalId.includes('..')) return [];
    const client = runtime.http || http;
    if (!client || typeof client.get !== 'function') throw error('SOURCE_ARCHIVE_INVALID_CONFIG');
    const requestUrl = new URL(`/metadata/${encodeURIComponent(ref.externalId)}`, base);
    let response;
    try {
      response = await client.get(requestUrl.toString(), {
        headers: { accept: 'application/json' }, timeoutMs,
        maxBytes: MAX_METADATA_BYTES, maxRedirects: 3, signal: runtime.signal,
      });
    } catch (cause) {
      if (cause?.code?.startsWith('HTTP_')) throw cause;
      throw error('SOURCE_ARCHIVE_REQUEST_FAILED');
    }
    if (response.status === 404) return [];
    if (!response.ok) throw error('SOURCE_ARCHIVE_HTTP_ERROR');
    if (!JSON_CONTENT_TYPE.test(response.headers?.['content-type'] || '')) {
      throw error('SOURCE_ARCHIVE_INVALID_CONTENT_TYPE');
    }
    let payload;
    try { payload = JSON.parse(response.body.toString('utf8')); } catch {
      throw error('SOURCE_ARCHIVE_INVALID_JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.metadata?.identifier !== ref.externalId ||
        payload.metadata?.mediatype !== 'movies' ||
        payload.is_dark === true || payload.is_restricted === true) return [];
    const licenseUrl = openLicense(payload.metadata.licenseurl);
    if (!licenseUrl) return [];
    const candidates = [];
    for (const file of selectMp4Files(payload.files, maxCandidates)) {
      const url = canonicalFileUrl(base, ref.externalId, file.name);
      if (!url) continue;
      const height = numericField(file.height);
      const candidate = normalizeEmbedCandidate({
        providerId: id, url, qualityHint: qualityFromHeight(height),
        metadata: {
          sourceType: 'internet_archive', itemId: ref.externalId,
          filename: file.name, format: file.format,
          mime: typeof file.mime === 'string' ? file.mime : null,
          size: numericField(file.size), licenseUrl,
          width: numericField(file.width), height,
        },
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  };
  return Object.freeze({
    descriptor: Object.freeze({ id, active: enabled, priority, supportsMovies,
      supportsEpisodes, languages: Object.freeze([]), strategy: 'http',
      timeoutMs, maxCandidates }),
    getSources,
  });
};

module.exports = { createInternetArchiveSourceProvider, openLicense,
  canonicalFileUrl, selectMp4Files, MAX_METADATA_BYTES };
