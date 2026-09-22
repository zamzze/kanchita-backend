'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanTopLevelChannelCoverageV2 } = require('./kodiChannelCoverageV2');
const { inspectRegexUseSemantics, scanChannelRegexGap } = require('./kodiChannelRegexGap');
const { createChannelCapabilityPayoff } = require('./kodiChannelCapabilityPayoff');

const RUNTIME_COMMIT = '75de87ed216e42a5ae2ba34ebef99a2727c218a4';
const ASSESSMENTS = Object.freeze(['EQUIVALENT', 'PARTIAL', 'NOT_EQUIVALENT', 'UNKNOWN']);
const RUNTIME_CONTRACT = Object.freeze({ parser: 'text', stepType: 'extract',
  source: 'previous_response_body', delimiters: 'literal_static', delimiterMinChars: 1,
  delimiterMaxChars: 256, match: 'first_start_then_first_following_end',
  maxCaptureChars: 4096, emptyCapture: 'miss', missingDelimiter: 'miss',
  objectArrayCoercion: false, regex: false, decode: false, replacement: false,
  scalarVariableChaining: false, loops: false, branches: false,
  overflowErrorCode: 'SOURCE_WORKFLOW_CAPTURE_TOO_LARGE', normalization: 'idempotent' });

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const unique = (values) => [...new Set(values)].sort();

const assessBoundedTextRequirement = (requirements = {}) => {
  const observedRequirements = unique(Object.entries(requirements)
    .filter(([, enabled]) => enabled === true).map(([name]) => name));
  let assessment = 'EQUIVALENT'; let reason = 'STATIC_LITERAL_SINGLE_RESPONSE_CAPTURE';
  if (requirements.regexRequired || requirements.decodeOrRewrite) {
    assessment = 'NOT_EQUIVALENT';
    reason = requirements.decodeOrRewrite ? 'POST_CAPTURE_TRANSFORM_REQUIRED'
      : 'REGEX_SEMANTICS_REQUIRED';
  } else if (requirements.scalarChaining || requirements.repeatedCapture ||
      requirements.caseInsensitive || requirements.unresolvedPatternReference ||
      requirements.multipleOutputs) {
    assessment = 'PARTIAL';
    reason = 'RUNTIME_CONTRACT_IS_NARROWER';
  } else if (requirements.unknown || requirements.responseBodyOnly !== true ||
      requirements.literalStaticDelimiters !== true) {
    assessment = 'UNKNOWN'; reason = 'INSUFFICIENT_STATIC_EVIDENCE';
  }
  return freeze({ assessment, reason, observedRequirements });
};

const requirementsForSource = (source) => {
  const uses = inspectRegexUseSemantics(source)
    .filter(({ category }) => category === 'REGEX_TEXT_CAPTURE');
  const staticUses = uses.filter(({ staticPattern }) => staticPattern);
  return freeze({
    responseBodyOnly: uses.length > 0 && uses.every(({ responseBodyInput }) => responseBodyInput),
    literalStaticDelimiters: uses.length > 0 &&
      uses.every(({ literalDelimiters }) => literalDelimiters),
    scalarChaining: uses.some(({ scalarInput }) => scalarInput),
    repeatedCapture: uses.some(({ repeatedCapture }) => repeatedCapture),
    caseInsensitive: uses.some(({ caseInsensitive }) => caseInsensitive),
    unresolvedPatternReference: staticUses.length !== uses.length,
    multipleOutputs: uses.some(({ captureCount }) => captureCount !== null && captureCount > 1),
    regexRequired: staticUses.some(({ literalDelimiters }) => !literalDelimiters),
    decodeOrRewrite: /\.decode\s*\(|html\.unescape|decodeURIComponent|\bre\.sub\s*\(/i
      .test(source),
    unknown: uses.length === 0,
  });
};

const createBoundedTextEquivalence = ({ payoff, channelSources } = {}) => {
  if (!payoff || !Array.isArray(payoff.channels) ||
      !channelSources || typeof channelSources !== 'object') {
    throw Object.assign(new Error('KODI_BOUNDED_TEXT_EQUIVALENCE_INVALID_INPUT'),
      { code: 'KODI_BOUNDED_TEXT_EQUIVALENCE_INVALID_INPUT' });
  }
  const profiles = payoff.channels.filter(({ requiredNewCapabilities }) =>
    requiredNewCapabilities.includes('bounded_text_capture'));
  const channels = profiles.map(({ channel }) => {
    const source = typeof channelSources[channel] === 'string' ? channelSources[channel] : '';
    return freeze({ channel, ...assessBoundedTextRequirement(requirementsForSource(source)) });
  }).sort((left, right) => left.channel.localeCompare(right.channel));
  const byAssessment = Object.fromEntries(ASSESSMENTS.map((assessment) =>
    [assessment, channels.filter((item) => item.assessment === assessment).length]));
  const predicted = payoff.candidateSets.find(({ capabilities }) =>
    capabilities.length === 1 && capabilities[0] === 'bounded_text_capture');
  const ag4Channels = predicted ? predicted.channels.fullyUnblocked : [];
  const equivalent = new Set(channels.filter(({ assessment }) => assessment === 'EQUIVALENT')
    .map(({ channel }) => channel));
  const runtimeChannels = ag4Channels.filter((channel) => equivalent.has(channel));
  const ciberdocumentales = channels.find(({ channel }) => channel === 'ciberdocumentales') ||
    freeze({ channel: 'ciberdocumentales', assessment: 'UNKNOWN',
      reason: 'CHANNEL_NOT_IN_BOUNDED_TEXT_PROFILE', observedRequirements: [] });
  return freeze({ runtimeCommit: RUNTIME_COMMIT, runtimeContract: RUNTIME_CONTRACT,
    ag4Model: { capability: 'bounded_text_capture', assumes: [
      'bounded_input', 'bounded_output', 'static_delimiters'],
    excludes: ['dynamic_patterns', 'execution', 'replacement'] },
    equivalent: ag4Channels.length === runtimeChannels.length,
    ciberdocumentales, summary: { channelsUsingBoundedText: channels.length,
      equivalentCount: byAssessment.EQUIVALENT, partialCount: byAssessment.PARTIAL,
      notEquivalentCount: byAssessment.NOT_EQUIVALENT, unknownCount: byAssessment.UNKNOWN },
    correctedPayoff: { AG4PredictedFullUnlock: ag4Channels.length,
      AG4PredictedChannels: [...ag4Channels],
      RuntimeEquivalentFullUnlock: runtimeChannels.length,
      RuntimeEquivalentChannels: runtimeChannels,
      exactMatch: ag4Channels.length === runtimeChannels.length &&
        ag4Channels.every((channel, index) => channel === runtimeChannels[index]) },
    channels });
};

const scanBoundedTextEquivalence = ({ root } = {}) => {
  const coverage = scanTopLevelChannelCoverageV2({ root });
  const regexGap = scanChannelRegexGap({ root, coverage });
  const payoff = createChannelCapabilityPayoff({ coverage, regexGap });
  const folder = path.basename(path.resolve(root)).toLowerCase() === 'channels'
    ? path.resolve(root) : path.join(path.resolve(root), 'channels');
  const channelSources = Object.create(null);
  for (const profile of payoff.channels) {
    if (profile.requiredNewCapabilities.includes('bounded_text_capture')) {
      channelSources[profile.channel] = fs.readFileSync(
        path.join(folder, `${profile.channel}.py`), 'utf8');
    }
  }
  return createBoundedTextEquivalence({ payoff, channelSources });
};

module.exports = { ASSESSMENTS, RUNTIME_COMMIT, RUNTIME_CONTRACT,
  assessBoundedTextRequirement, createBoundedTextEquivalence, requirementsForSource,
  scanBoundedTextEquivalence };
