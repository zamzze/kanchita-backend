'use strict';

const crypto = require('node:crypto');
const { normalizeStreamCandidate } = require('../resolverContracts');

const LANGUAGE_RANK = Object.freeze({ latino: 5, castellano: 4, vose: 3, vo: 2, unknown: 1 });
const QUALITY_RANK = Object.freeze({ '1080p': 5, '720p': 4, auto: 3, '480p': 2,
  '2160p': 1, unknown: 0 });
const PROTOCOL_RANK = Object.freeze({ hls: 4, mp4: 3, dash: 2, unknown: 1 });
const LATINO = new Set(['es-419', 'es-mx', 'es-us', 'lat', 'latino', 'spanish-latam']);
const CASTELLANO = new Set(['es', 'es-es', 'spa', 'castellano', 'spanish']);
const ENGLISH = new Set(['en', 'eng', 'english']);

const normalizedText = (value) => typeof value === 'string'
  ? value.trim().toLowerCase().replaceAll('_', '-') : '';

const normalizeLanguage = (value) => {
  const language = normalizedText(value);
  if (LATINO.has(language)) return 'latino';
  if (CASTELLANO.has(language)) return 'castellano';
  if (ENGLISH.has(language)) return 'english';
  return 'unknown';
};

const classifyLanguage = (audioLanguage, subtitleLanguage) => {
  const audio = normalizeLanguage(audioLanguage);
  const subtitle = normalizeLanguage(subtitleLanguage);
  if (audio === 'latino') return { tier: 'latino', rank: 5, subtitleRank: 0 };
  if (audio === 'castellano') return { tier: 'castellano', rank: 4, subtitleRank: 0 };
  if (audio === 'english' && (subtitle === 'latino' || subtitle === 'castellano')) {
    return { tier: 'vose', rank: 3, subtitleRank: subtitle === 'latino' ? 2 : 1 };
  }
  if (audio === 'english') return { tier: 'vo', rank: 2, subtitleRank: 0 };
  return { tier: 'unknown', rank: 1, subtitleRank: 0 };
};

const normalizeQuality = (value) => {
  const quality = normalizedText(value).replaceAll(' ', '');
  if (quality === '1920x1080' || quality === '1080' || quality === '1080p' ||
      quality === 'fullhd' || quality === 'fhd') return '1080p';
  if (quality === '1280x720' || quality === '720' || quality === '720p') return '720p';
  if (quality === '854x480' || quality === '480' || quality === '480p') return '480p';
  if (quality === '2160' || quality === '2160p' || quality === '4k' || quality === 'uhd') {
    return '2160p';
  }
  if (quality === 'auto') return 'auto';
  return 'unknown';
};

const qualityFromHls = (hlsInfo) => {
  if (!hlsInfo || !Array.isArray(hlsInfo.variants)) return null;
  const tiers = hlsInfo.variants.map((variant) =>
    normalizeQuality(variant?.resolution || (variant?.width && variant?.height
      ? `${variant.width}x${variant.height}` : null)));
  return tiers.sort((left, right) => QUALITY_RANK[right] - QUALITY_RANK[left])[0] || null;
};

const qualityTier = (stream) => qualityFromHls(stream.hlsInfo) || normalizeQuality(stream.quality);
const safePriority = (value) => Number.isInteger(value) ? value : 0;
const fingerprint = (url) => crypto.createHash('sha256').update(url).digest('hex');

const createStreamRanker = ({ now = Date.now, protocolRanks = PROTOCOL_RANK } = {}) => {
  if (typeof now !== 'function' || !protocolRanks || typeof protocolRanks !== 'object') {
    throw new Error('STREAM_RANKER_INVALID_INPUT');
  }
  const describe = (stream, observedAt) => {
    const language = classifyLanguage(stream.audioLanguage, stream.subtitleLanguage);
    const quality = qualityTier(stream);
    const expiry = stream.expiresAt ? new Date(stream.expiresAt).getTime() : null;
    return {
      stream,
      language,
      quality,
      tuple: [
        stream.validated ? 1 : 0,
        stream.protocol === 'hls' ? 1 : 0,
        language.rank,
        language.subtitleRank,
        QUALITY_RANK[quality] || 0,
        protocolRanks[stream.protocol] || 0,
        safePriority(stream.metadata?.sourcePriority),
        safePriority(stream.metadata?.resolverPriority),
        stream.latencyMs === null ? Number.NEGATIVE_INFINITY : -stream.latencyMs,
        expiry === null ? 0 : expiry - observedAt,
      ],
      expiry,
      tie: `${stream.providerId}\u0000${stream.resolverId}\u0000${fingerprint(stream.url)}`,
    };
  };
  const compare = (left, right) => {
    for (let index = 0; index < left.tuple.length; index += 1) {
      if (left.tuple[index] !== right.tuple[index]) return right.tuple[index] - left.tuple[index];
    }
    return left.tie.localeCompare(right.tie);
  };
  const rank = (streams) => {
    if (!Array.isArray(streams)) throw new Error('STREAM_RANKER_INVALID_INPUT');
    const observedAt = now();
    return streams.map(normalizeStreamCandidate).filter(Boolean)
      .map((stream) => describe(stream, observedAt))
      .filter(({ expiry }) => expiry === null || expiry > observedAt)
      .sort(compare).map(({ stream }) => stream);
  };
  const selectBest = (streams) => {
    const ranked = rank(streams);
    const selected = ranked[0] || null;
    const language = selected
      ? classifyLanguage(selected.audioLanguage, selected.subtitleLanguage) : null;
    return {
      selected,
      ranked,
      reason: selected ? Object.freeze({
        languageTier: language.tier,
        qualityTier: qualityTier(selected),
        protocolTier: selected.protocol,
        validated: selected.validated === true,
        resolverStrategy: ['direct', 'http', 'browser'].includes(
          selected.metadata?.resolverStrategy) ? selected.metadata.resolverStrategy : 'unknown',
      }) : null,
    };
  };
  return Object.freeze({ rank, selectBest });
};

module.exports = { LANGUAGE_RANK, QUALITY_RANK, PROTOCOL_RANK, classifyLanguage,
  normalizeLanguage, normalizeQuality, qualityTier, createStreamRanker };
