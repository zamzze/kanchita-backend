'use strict';

const AD_MARKERS = [
  '#EXT-X-CUE-OUT',
  '#EXT-X-CUE-IN',
  'SCTE35-OUT',
  'SCTE35-IN',
  'SCTE-35',
];

const daterangeMarksAds = (line) => {
  if (!line.startsWith('#EXT-X-DATERANGE:')) return false;
  if (/SCTE-?35|INTERSTITIAL/i.test(line)) return true;
  return /(?:^|[:,\s])(?:ID|CLASS)\s*=\s*"?(?:AD|ADS|ADVERT|ADVERTISEMENT)(?:[-_.:]|"|,|$)/i
    .test(line);
};

const inspectManifestCleanliness = (manifest) => {
  if (typeof manifest !== 'string' || !manifest.trim().startsWith('#EXTM3U')) {
    return 'unknown';
  }
  const normalized = manifest.toUpperCase();
  return AD_MARKERS.some((marker) => normalized.includes(marker)) ||
    normalized.split(/\r?\n/).some(daterangeMarksAds)
    ? 'ad_marked'
    : 'clean';
};

module.exports = { AD_MARKERS, daterangeMarksAds, inspectManifestCleanliness };
