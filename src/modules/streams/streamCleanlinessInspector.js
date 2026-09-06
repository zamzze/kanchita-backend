'use strict';

const AD_MARKERS = [
  '#EXT-X-CUE-OUT',
  '#EXT-X-CUE-IN',
  '#EXT-X-DATERANGE',
  'SCTE35-OUT',
  'SCTE35-IN',
  'SCTE-35',
];

const inspectManifestCleanliness = (manifest) => {
  if (typeof manifest !== 'string' || !manifest.trim().startsWith('#EXTM3U')) {
    return 'unknown';
  }
  const normalized = manifest.toUpperCase();
  return AD_MARKERS.some((marker) => normalized.includes(marker))
    ? 'ad_marked'
    : 'clean';
};

module.exports = { AD_MARKERS, inspectManifestCleanliness };
