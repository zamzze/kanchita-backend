'use strict';

const QUALITY_VALUES = new Set(['2160p', '1080p', '720p', '480p', 'auto', 'unknown']);
const LATIN_SPANISH = new Set(['es-419', 'es-mx', 'es-us']);

const normalizeLanguage = (value) => {
  const language = String(value || '').trim().toLowerCase().replace('_', '-');
  if (language === 'en-sub') return 'en';
  if (['lat', 'latino', 'es-lat', 'es-latam', 'spa-lat'].includes(language)) return 'es-419';
  if (LATIN_SPANISH.has(language)) return language;
  if (language.startsWith('es')) return 'es';
  if (language.startsWith('en')) return 'en';
  return 'unknown';
};

const normalizeQuality = (value) => {
  const quality = String(value || '').trim().toLowerCase();
  if (quality.includes('2160') || quality === '4k') return '2160p';
  if (quality.includes('1080')) return '1080p';
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
  '1080p': 100,
  '720p': 50,
  auto: 25,
  '480p': 10,
  '2160p': 5,
  unknown: 0,
})[normalizeQuality(quality)];

const streamScore = (candidate) => {
  const cleanliness = { clean: 1_000_000, unknown: 500_000, ad_marked: 0 }[
    candidate.cleanliness || 'unknown'
  ] ?? 0;
  const speed = candidate.ready ? 100_000 : 0;
  const strategy = candidate.strategy === 'direct' ? 50_000 : 0;
  return cleanliness + speed + strategy + qualityScore(candidate.quality) * 100 +
    languageScore(candidate);
};

module.exports = {
  LATIN_SPANISH,
  QUALITY_VALUES,
  languageScore,
  normalizeLanguage,
  normalizeQuality,
  qualityScore,
  streamScore,
};
