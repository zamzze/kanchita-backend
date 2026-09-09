'use strict';

const { LANGUAGE_RANK, QUALITY_RANK, classifyLanguage, normalizeQuality } =
  require('../ranking/streamRanker');

const browserState = (legacy) => legacy?.strategy === 'browser' ? true
  : legacy?.strategy === 'direct' ? false : 'unknown';

const compareQuality = (shadowSelected, legacy) => {
  if (!shadowSelected || !legacy) return 'unknown';
  const legacyLanguage = classifyLanguage(legacy.audioLanguage, legacy.subtitleLanguage);
  const legacyQuality = normalizeQuality(legacy.quality);
  if (legacyLanguage.tier === 'unknown' || legacyQuality === 'unknown' ||
      !LANGUAGE_RANK[shadowSelected.languageTier] ||
      !QUALITY_RANK[shadowSelected.qualityTier]) return 'unknown';
  const shadowTuple = [LANGUAGE_RANK[shadowSelected.languageTier],
    QUALITY_RANK[shadowSelected.qualityTier]];
  const legacyTuple = [legacyLanguage.rank, QUALITY_RANK[legacyQuality]];
  for (let index = 0; index < shadowTuple.length; index += 1) {
    if (shadowTuple[index] > legacyTuple[index]) return 'shadow_better';
    if (shadowTuple[index] < legacyTuple[index]) return 'legacy_better';
  }
  return 'equivalent';
};

const createShadowLegacyComparator = () => {
  const compare = ({ shadow, legacy } = {}) => {
    const selected = shadow?.selected || null;
    const legacyBrowserUsed = browserState(legacy);
    const shadowReady = shadow?.status === 'success' && selected !== null;
    const acceptable = shadowReady && selected.validated === true && selected.protocol === 'hls';
    const wouldAvoidBrowser = legacyBrowserUsed === 'unknown' ? 'unknown'
      : legacyBrowserUsed === true && acceptable;
    return Object.freeze({
      shadowStatus: typeof shadow?.status === 'string' ? shadow.status : 'failed',
      shadowReady,
      legacyReady: Boolean(legacy),
      legacyBrowserUsed,
      wouldAvoidBrowser,
      qualityComparison: compareQuality(selected, legacy),
      selected: selected ? Object.freeze({
        protocol: ['hls', 'mp4', 'dash', 'unknown'].includes(selected.protocol)
          ? selected.protocol : 'unknown',
        qualityTier: typeof selected.qualityTier === 'string'
          ? selected.qualityTier : 'unknown',
        languageTier: typeof selected.languageTier === 'string'
          ? selected.languageTier : 'unknown',
        validated: selected.validated === true,
        resolverStrategy: ['direct', 'http', 'browser'].includes(selected.resolverStrategy)
          ? selected.resolverStrategy : 'unknown',
      }) : null,
    });
  };
  return Object.freeze({ compare });
};

module.exports = { browserState, compareQuality, createShadowLegacyComparator };
