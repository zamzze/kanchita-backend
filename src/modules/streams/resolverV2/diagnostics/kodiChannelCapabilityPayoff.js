'use strict';

const { scanTopLevelChannelCoverageV2 } = require('./kodiChannelCoverageV2');
const { scanChannelRegexGap } = require('./kodiChannelRegexGap');

const CANDIDATE_SETS = Object.freeze([
  ['bounded_text_capture'],
  ['safe_regex_single_capture'],
  ['multi_value_extract'],
  ['direct_mp4'],
  ['bounded_text_capture', 'safe_regex_single_capture'],
  ['bounded_text_capture', 'multi_value_extract'],
  ['safe_regex_single_capture', 'multi_value_extract'],
  ['bounded_text_capture', 'safe_regex_single_capture', 'multi_value_extract'],
].map((values) => Object.freeze([...values].sort())));

const EXCLUDED_CAPABILITY_MAP = Object.freeze({
  javascript_transform: 'javascript_transform',
  persistent_session: 'persistent_session',
  browser_automation: 'browser_automation',
  anti_bot_bypass: 'anti_bot_bypass',
  proxy_or_geo: 'proxy_or_geo',
  manifest_synthesis: 'manifest_synthesis',
  unknown_pattern: 'unknown_pattern',
});
const REGEX_REQUIREMENTS = Object.freeze({
  REGEX_SIMPLE_CAPTURE: 'safe_regex_single_capture',
  REGEX_TEXT_CAPTURE: 'bounded_text_capture',
  REGEX_MULTI_CAPTURE: 'multi_value_extract',
});
const REGEX_EXCLUSIONS = Object.freeze({
  REGEX_REWRITE: 'complex_regex_rewrite',
  REGEX_DECODE_CHAIN: 'complex_decode_chain',
  REGEX_JAVASCRIPT_COUPLED: 'javascript_transform',
  REGEX_DYNAMIC_PATTERN: 'dynamic_regex_pattern',
  UNKNOWN_REGEX_USE: 'unknown_regex_use',
});

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const unique = (values) => [...new Set(values)].sort();
const setKey = (values) => values.join('+');

const regexRecordsByChannel = (regexGap) => {
  const result = new Map();
  for (const record of regexGap.records || []) {
    if (!result.has(record.channel)) result.set(record.channel, []);
    result.get(record.channel).push(record);
  }
  return result;
};
const mp4ByChannel = (regexGap) => new Map((regexGap.directMp4 || [])
  .map((item) => [item.channel, item]));

const createChannelRequirementProfiles = (coverage, regexGap) => {
  const regexByChannel = regexRecordsByChannel(regexGap);
  const mp4 = mp4ByChannel(regexGap);
  return coverage.channels.map((channel) => {
    const required = new Set(); const excluded = new Set();
    const notes = [];
    const regexRecords = regexByChannel.get(channel.channel) || [];
    for (const record of regexRecords) {
      const requirement = REGEX_REQUIREMENTS[record.category];
      const blocker = REGEX_EXCLUSIONS[record.category];
      if (requirement) required.add(requirement);
      if (blocker) excluded.add(blocker);
    }
    if (channel.missingCapabilities.includes('html_regex_transform') && !regexRecords.length) {
      excluded.add('unknown_regex_use');
    }
    for (const gap of channel.missingCapabilities) {
      if (gap === 'html_regex_transform' || gap === 'direct_mp4') continue;
      const blocker = EXCLUDED_CAPABILITY_MAP[gap];
      if (blocker) excluded.add(blocker);
      else required.add(gap);
    }
    if (channel.missingCapabilities.includes('direct_mp4')) {
      const role = mp4.get(channel.channel)?.role || 'UNKNOWN';
      required.add('direct_mp4');
      if (role !== 'FINAL_DIRECT_OUTPUT') {
        excluded.add('non_primary_mp4');
        notes.push(`direct_mp4:${role.toLowerCase()}`);
      } else notes.push('direct_mp4:final_direct_output');
    }
    return freeze({ channel: channel.channel, basePattern: channel.pattern,
      currentAssessment: channel.assessment, requiredNewCapabilities: [...required].sort(),
      excludedBlockers: [...excluded].sort(), unlockable: excluded.size === 0,
      notes: notes.sort() });
  }).sort((left, right) => left.channel.localeCompare(right.channel));
};

const evaluateSet = (profiles, capabilities) => {
  const supplied = new Set(capabilities);
  const fullyUnblocked = []; const partiallyReduced = []; const unchanged = [];
  const blockedByExcludedCapabilities = [];
  for (const profile of profiles) {
    const removed = profile.requiredNewCapabilities.filter((value) => supplied.has(value));
    const remaining = profile.requiredNewCapabilities.filter((value) => !supplied.has(value));
    if (profile.excludedBlockers.length) blockedByExcludedCapabilities.push(profile.channel);
    if (removed.length && !remaining.length && !profile.excludedBlockers.length) {
      fullyUnblocked.push(profile.channel);
    } else if (removed.length) partiallyReduced.push(profile.channel);
    else unchanged.push(profile.channel);
  }
  return freeze({ capabilities: [...capabilities], fullyUnblocked: fullyUnblocked.length,
    partiallyReduced: partiallyReduced.length, unchanged: unchanged.length,
    blockedByExcludedCapabilities: blockedByExcludedCapabilities.length,
    channels: { fullyUnblocked, partiallyReduced, unchanged, blockedByExcludedCapabilities } });
};

const compareCandidateSets = (left, right) => right.fullyUnblocked - left.fullyUnblocked ||
  left.capabilities.length - right.capabilities.length ||
  setKey(left.capabilities).localeCompare(setKey(right.capabilities));

const createMarginalPayoff = (profiles, evaluated) => {
  const byKey = new Map(evaluated.map((item) => [setKey(item.capabilities), item]));
  const empty = evaluateSet(profiles, []);
  const entries = [];
  for (const result of evaluated) {
    for (const addedCapability of result.capabilities) {
      const overCapabilities = result.capabilities.filter((value) => value !== addedCapability);
      const baseline = byKey.get(setKey(overCapabilities)) || evaluateSet(profiles, overCapabilities);
      const baselineChannels = new Set(baseline.channels.fullyUnblocked);
      const additionalChannels = result.channels.fullyUnblocked
        .filter((channel) => !baselineChannels.has(channel));
      entries.push(freeze({ capabilities: result.capabilities, overCapabilities,
        addedCapability, additionalFullyUnblocked: additionalChannels.length,
        channels: additionalChannels }));
    }
  }
  return entries.sort((left, right) => setKey(left.capabilities)
    .localeCompare(setKey(right.capabilities)) ||
    left.addedCapability.localeCompare(right.addedCapability));
};

const createDirectMp4Impact = (profiles, regexGap, evaluated) => {
  const directResult = evaluated.find(({ capabilities }) =>
    capabilities.length === 1 && capabilities[0] === 'direct_mp4');
  const profileById = new Map(profiles.map((profile) => [profile.channel, profile]));
  return (regexGap.directMp4 || []).map((item) => {
    const profile = profileById.get(item.channel);
    const outcome = directResult.channels.fullyUnblocked.includes(item.channel)
      ? 'FULLY_UNBLOCKED'
      : directResult.channels.partiallyReduced.includes(item.channel)
        ? 'PARTIALLY_REDUCED' : 'UNCHANGED';
    return freeze({ channel: item.channel, role: item.role, outcome,
      remainingCapabilities: profile.requiredNewCapabilities
        .filter((value) => value !== 'direct_mp4'),
      excludedBlockers: profile.excludedBlockers });
  });
};

const createChannelCapabilityPayoff = ({ coverage, regexGap,
  candidateSets = CANDIDATE_SETS } = {}) => {
  if (!coverage || !Array.isArray(coverage.channels) || !regexGap ||
      !Array.isArray(regexGap.records)) {
    throw Object.assign(new Error('KODI_CHANNEL_CAPABILITY_PAYOFF_INVALID_INPUT'),
      { code: 'KODI_CHANNEL_CAPABILITY_PAYOFF_INVALID_INPUT' });
  }
  const normalizedSets = candidateSets.map((values) => unique(values));
  const profiles = createChannelRequirementProfiles(coverage, regexGap);
  const candidateResults = normalizedSets.map((values) => evaluateSet(profiles, values))
    .sort(compareCandidateSets);
  const best = candidateResults[0] || evaluateSet(profiles, []);
  const excludedBlockers = {};
  for (const profile of profiles) {
    for (const blocker of profile.excludedBlockers) {
      if (!excludedBlockers[blocker]) excludedBlockers[blocker] = [];
      excludedBlockers[blocker].push(profile.channel);
    }
  }
  return freeze({ population: { channels: profiles.length }, candidateSets: candidateResults,
    bestByFullUnlockCount: { capabilities: best.capabilities,
      fullyUnblocked: best.fullyUnblocked },
    marginalPayoff: createMarginalPayoff(profiles, candidateResults),
    excludedBlockers, directMp4Impact: createDirectMp4Impact(profiles, regexGap,
      candidateResults), channels: profiles });
};

const scanChannelCapabilityPayoff = ({ root } = {}) => {
  const coverage = scanTopLevelChannelCoverageV2({ root });
  const regexGap = scanChannelRegexGap({ root, coverage });
  return createChannelCapabilityPayoff({ coverage, regexGap });
};

module.exports = {
  CANDIDATE_SETS,
  createChannelCapabilityPayoff,
  createChannelRequirementProfiles,
  evaluateSet,
  scanChannelCapabilityPayoff,
};
