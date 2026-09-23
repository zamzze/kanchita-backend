'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanTopLevelChannelCoverageV2 } = require('./kodiChannelCoverageV2');
const { scanChannelRegexGap, inspectRegexUseSemantics } = require('./kodiChannelRegexGap');

const RUNTIME_COMMIT = '75de87ed216e42a5ae2ba34ebef99a2727c218a4';
const BASELINE = Object.freeze(['literal_response_body_capture']);
const TAXONOMY = Object.freeze([
  'literal_response_body_capture', 'scalar_capture_chaining', 'repeated_capture',
  'multi_value_extract', 'safe_regex_single_capture', 'safe_regex_multi_capture',
  'static_decode', 'text_recode', 'bounded_rewrite', 'dynamic_regex',
  'javascript_transform', 'unknown_pattern',
]);
const CANDIDATES = Object.freeze([
  'scalar_capture_chaining', 'repeated_capture', 'multi_value_extract',
  'safe_regex_single_capture',
]);
const BLOCKERS = Object.freeze({
  persistent_session: 'persistent_session', browser_automation: 'browser_automation',
  anti_bot_bypass: 'anti_bot_bypass', proxy_or_geo: 'proxy_or_geo',
  javascript_transform: 'javascript_transform', unknown_pattern: 'unknown_pattern',
  manifest_synthesis: 'manifest_synthesis',
});
const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const sorted = (values) => [...new Set(values)].sort();

const regexRequirements = (source, records = []) => {
  const required = new Set(); const blockers = new Set();
  const uses = inspectRegexUseSemantics(source);
  const categories = new Set(records.map(({ category }) => category));
  for (const use of uses) {
    if (use.category === 'REGEX_JAVASCRIPT_COUPLED') {
      required.add('javascript_transform'); blockers.add('javascript_transform');
    } else if (use.category === 'REGEX_DYNAMIC_PATTERN') {
      required.add('dynamic_regex'); blockers.add('dynamic_regex');
    } else if (use.category === 'UNKNOWN_REGEX_USE') {
      required.add('unknown_pattern'); blockers.add('unknown_pattern');
    } else if (use.category === 'REGEX_REWRITE') required.add('bounded_rewrite');
    else if (use.category === 'REGEX_DECODE_CHAIN') required.add('static_decode');
    else if (use.category === 'REGEX_MULTI_CAPTURE') {
      required.add('multi_value_extract');
      required.add('safe_regex_multi_capture');
    } else if (use.category === 'REGEX_SIMPLE_CAPTURE' ||
        use.category === 'REGEX_TEXT_CAPTURE') {
      if (use.staticPattern && use.literalDelimiters && use.responseBodyInput &&
          !use.caseInsensitive && use.captureCount === 1) {
        required.add('literal_response_body_capture');
      } else if (use.staticPattern && use.literalDelimiters && use.scalarInput &&
          !use.caseInsensitive && use.captureCount === 1) {
        required.add('scalar_capture_chaining');
      } else if (use.staticPattern && use.captureCount === 1) {
        required.add('safe_regex_single_capture');
      } else if (!use.staticPattern) {
        required.add('unknown_pattern'); blockers.add('unknown_pattern');
      }
    }
    if (use.scalarInput) required.add('scalar_capture_chaining');
    if (use.repeatedCapture) required.add('repeated_capture');
    if (use.caseInsensitive && use.staticPattern && use.captureCount === 1) {
      required.add('safe_regex_single_capture');
    }
    if (!use.responseBodyInput && !use.scalarInput &&
        !['REGEX_REWRITE', 'REGEX_DECODE_CHAIN'].includes(use.category)) {
      required.add('unknown_pattern'); blockers.add('unknown_pattern');
    }
  }
  if (records.length) {
    if (/\.decode\s*\([^)]*\)\s*\.encode\s*\(|\.encode\s*\([^)]*\)\s*\.decode\s*\(/i
      .test(source)) required.add('text_recode');
    else if (/\.decode\s*\(|html\.unescape\s*\(|\bb64decode\s*\(/i.test(source)) {
      required.add('static_decode');
    }
  }
  if (categories.has('REGEX_DYNAMIC_PATTERN')) blockers.add('dynamic_regex');
  if (categories.has('UNKNOWN_REGEX_USE')) blockers.add('unknown_pattern');
  return { required, blockers };
};

const createChannelProfile = (channel, source, regexRecords = []) => {
  const hasRegexGap = (channel.missingCapabilities || []).includes('html_regex_transform');
  const { required, blockers } = hasRegexGap
    ? regexRequirements(source, regexRecords) : { required: new Set(), blockers: new Set() };
  for (const gap of channel.missingCapabilities || []) {
    if (gap === 'html_regex_transform') {
      if (!regexRecords.length) {
        required.add('unknown_pattern'); blockers.add('unknown_pattern');
      }
      continue;
    }
    required.add(gap);
    if (BLOCKERS[gap]) blockers.add(BLOCKERS[gap]);
  }
  const existing = sorted([...required].filter((capability) => BASELINE.includes(capability)));
  const missing = sorted([...required].filter((capability) => !BASELINE.includes(capability)));
  return freeze({ channel: channel.channel, requiredCapabilities: sorted(required),
    existingCapabilities: existing, missingCapabilities: missing,
    excludedBlockers: sorted(blockers) });
};

const candidateSets = () => {
  const sets = CANDIDATES.map((capability) => [capability]);
  for (let left = 0; left < CANDIDATES.length; left += 1) {
    for (let right = left + 1; right < CANDIDATES.length; right += 1) {
      sets.push([CANDIDATES[left], CANDIDATES[right]]);
    }
  }
  return sets.map(sorted).sort((left, right) => left.length - right.length ||
    left.join('+').localeCompare(right.join('+')));
};

const evaluatePayoff = (profiles, capabilities) => {
  const available = new Set([...BASELINE, ...capabilities]);
  const baseline = profiles.filter((profile) => !profile.missingCapabilities.length &&
    !profile.excludedBlockers.length).length;
  const affected = profiles.filter((profile) => profile.missingCapabilities.some((capability) =>
    capabilities.includes(capability))).map(({ channel }) => channel);
  const fullyUnlocked = profiles.filter((profile) => !profile.excludedBlockers.length &&
    profile.requiredCapabilities.every((capability) => available.has(capability)))
    .map(({ channel }) => channel);
  const fullSet = new Set(fullyUnlocked);
  const partial = affected.filter((channel) => !fullSet.has(channel));
  return freeze({ capabilities: sorted(capabilities), fullUnlockDelta: fullyUnlocked.length - baseline,
    partialReductionDelta: partial.length, affectedChannels: affected,
    fullyUnlockedChannels: fullyUnlocked.filter((channel) => profiles.find((profile) =>
      profile.channel === channel).missingCapabilities.length > 0),
    partiallyReducedChannels: partial });
};

const createChannelCapabilityModelV2 = ({ coverage, regexGap, channelSources } = {}) => {
  if (!coverage || !Array.isArray(coverage.channels) || !regexGap ||
      !Array.isArray(regexGap.records) || !channelSources ||
      typeof channelSources !== 'object') {
    throw Object.assign(new Error('KODI_CHANNEL_CAPABILITY_MODEL_V2_INVALID_INPUT'),
      { code: 'KODI_CHANNEL_CAPABILITY_MODEL_V2_INVALID_INPUT' });
  }
  const byChannel = new Map();
  for (const record of regexGap.records) {
    if (!byChannel.has(record.channel)) byChannel.set(record.channel, []);
    byChannel.get(record.channel).push(record);
  }
  const profiles = coverage.channels.map((channel) => createChannelProfile(channel,
    typeof channelSources[channel.channel] === 'string' ? channelSources[channel.channel] : '',
    byChannel.get(channel.channel) || []))
    .sort((left, right) => left.channel.localeCompare(right.channel));
  const currentlyRepresentableChannels = profiles.filter((profile) =>
    !profile.missingCapabilities.length && !profile.excludedBlockers.length)
    .map(({ channel }) => channel);
  const currentlyPartiallyReducedChannels = profiles.filter((profile) =>
    profile.existingCapabilities.length && profile.missingCapabilities.length)
    .map(({ channel }) => channel);
  const remainingRequirementProfiles = profiles.filter((profile) =>
    profile.missingCapabilities.length || profile.excludedBlockers.length);
  return freeze({ runtimeCommit: RUNTIME_COMMIT, taxonomy: TAXONOMY,
    runtimeCapabilities: BASELINE, population: { channels: profiles.length },
    currentlyRepresentableChannels, currentlyPartiallyReducedChannels,
    remainingRequirementProfiles, channels: profiles,
    payoff: candidateSets().map((set) => evaluatePayoff(profiles, set)) });
};

const scanChannelCapabilityModelV2 = ({ root } = {}) => {
  const coverage = scanTopLevelChannelCoverageV2({ root });
  const regexGap = scanChannelRegexGap({ root, coverage });
  const folder = path.basename(path.resolve(root)).toLowerCase() === 'channels'
    ? path.resolve(root) : path.join(path.resolve(root), 'channels');
  const channelSources = Object.create(null);
  for (const channel of coverage.channels) {
    channelSources[channel.channel] = fs.readFileSync(path.join(folder,
      `${channel.channel}.py`), 'utf8');
  }
  return createChannelCapabilityModelV2({ coverage, regexGap, channelSources });
};

module.exports = { BASELINE, CANDIDATES, TAXONOMY, createChannelCapabilityModelV2,
  createChannelProfile, evaluatePayoff, scanChannelCapabilityModelV2 };
