'use strict';

const createShadowComparisonStats = () => {
  const counters = {
    comparisons: 0, shadow_ready: 0, shadow_empty: 0, shadow_failed: 0,
    shadow_timeout: 0, legacy_ready: 0, legacy_browser_used: 0,
    legacy_browser_unknown: 0, would_avoid_browser: 0, shadow_better: 0,
    equivalent: 0, legacy_better: 0, quality_unknown: 0,
  };
  const record = (summary) => {
    if (!summary || typeof summary !== 'object') throw new Error('SHADOW_STATS_INVALID_INPUT');
    counters.comparisons += 1;
    if (summary.shadowReady) counters.shadow_ready += 1;
    else if (summary.shadowStatus === 'timeout') counters.shadow_timeout += 1;
    else if (summary.shadowStatus === 'failed') counters.shadow_failed += 1;
    else counters.shadow_empty += 1;
    if (summary.legacyReady) counters.legacy_ready += 1;
    if (summary.legacyBrowserUsed === true) counters.legacy_browser_used += 1;
    else if (summary.legacyBrowserUsed === 'unknown') counters.legacy_browser_unknown += 1;
    if (summary.wouldAvoidBrowser === true) counters.would_avoid_browser += 1;
    if (summary.qualityComparison === 'shadow_better') counters.shadow_better += 1;
    else if (summary.qualityComparison === 'equivalent') counters.equivalent += 1;
    else if (summary.qualityComparison === 'legacy_better') counters.legacy_better += 1;
    else counters.quality_unknown += 1;
  };
  const snapshot = () => Object.freeze({
    ...counters,
    shadowReadyRate: counters.comparisons
      ? counters.shadow_ready / counters.comparisons : null,
    browserFallbackRate: counters.comparisons - counters.legacy_browser_unknown
      ? counters.legacy_browser_used /
        (counters.comparisons - counters.legacy_browser_unknown) : null,
    browserAvoidanceRate: counters.legacy_browser_used
      ? counters.would_avoid_browser / counters.legacy_browser_used : null,
    browserAvoidancePotential: counters.legacy_browser_used
      ? counters.would_avoid_browser / counters.legacy_browser_used : null,
  });
  return Object.freeze({ record, snapshot });
};

module.exports = { createShadowComparisonStats };
