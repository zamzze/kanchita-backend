'use strict';

const QUALITY_VALUES = new Set(['2160p', '1080p', '720p', '480p', 'auto', 'unknown']);
const LATIN_SPANISH = new Set(['es-419']);

const normalizeLanguage = (value) => {
  const language = String(value || '').trim().toLowerCase().replace('_', '-');
  if (language === 'en-sub') return 'en';
  if ([
    'lat', 'latin', 'latam', 'latino', 'spanish-latin', 'spanish latin',
    'spanish-latam', 'spanish latam', 'es-lat', 'es-latam', 'spa-lat',
    'es-419', 'es-mx', 'es-us',
  ].includes(language)) return 'es-419';
  if (language.startsWith('es')) return 'es';
  if (language.startsWith('en')) return 'en';
  if (language.startsWith('pt')) return 'pt';
  return 'unknown';
};

const normalizeQuality = (value) => {
  const quality = String(value || '').trim().toLowerCase();
  if (quality.includes('2160') || quality === '4k' || quality.includes('uhd')) return '2160p';
  if (quality.includes('1080') || quality === 'fhd' || quality.includes('fullhd') ||
    quality.includes('full hd')) return '1080p';
  if (quality.includes('720')) return '720p';
  if (quality.includes('480')) return '480p';
  if (quality === 'auto') return 'auto';
  return 'unknown';
};

const languageScore = ({ audioLanguage, subtitleLanguage }) => {
  const audio = normalizeLanguage(audioLanguage);
  const subtitle = normalizeLanguage(subtitleLanguage);
  if (LATIN_SPANISH.has(audio)) return 40;
  if (audio === 'es') return 25;
  if (audio === 'en' && LATIN_SPANISH.has(subtitle)) return 20;
  if (audio === 'en' && subtitle === 'es') return 15;
  return 0;
};

const qualityScore = (quality) => ({
  '2160p': 200,
  '1080p': 150,
  '720p': 75,
  auto: 25,
  '480p': 10,
  unknown: 0,
})[normalizeQuality(quality)];

const latencyScore = (milliseconds) => {
  const latency = Number(milliseconds);
  if (!Number.isFinite(latency) || latency < 0) return 0;
  return Math.max(0, 100 - Math.min(100, Math.floor(latency / 100)));
};

const streamScore = (candidate) => {
  const cleanliness = { clean: 10_000_000_000, unknown: 5_000_000_000, ad_marked: 0 }[
    candidate.cleanliness || 'unknown'
  ] ?? 0;
  const ready = candidate.ready ? 1_000_000_000 : 0;
  const strategy = candidate.strategy === 'direct' ? 100_000_000 : 0;
  const latency = latencyScore(candidate.avgResolutionMs) * 100_000;
  const quality = qualityScore(candidate.quality) * 1_000;
  const audio = languageScore({ audioLanguage: candidate.audioLanguage }) * 10;
  const subtitle = languageScore({
    audioLanguage: 'en', subtitleLanguage: candidate.subtitleLanguage,
  });
  return cleanliness + ready + strategy + latency + quality + audio + subtitle;
};

module.exports = {
  LATIN_SPANISH,
  QUALITY_VALUES,
  languageScore,
  latencyScore,
  normalizeLanguage,
  normalizeQuality,
  qualityScore,
  streamScore,
};
