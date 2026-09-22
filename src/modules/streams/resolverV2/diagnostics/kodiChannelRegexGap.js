'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanTopLevelChannelCoverageV2 } = require('./kodiChannelCoverageV2');

const REGEX_USE_CATEGORIES = Object.freeze([
  'REGEX_SIMPLE_CAPTURE',
  'REGEX_ATTRIBUTE_EXTRACTION',
  'REGEX_TEXT_CAPTURE',
  'REGEX_MULTI_CAPTURE',
  'REGEX_REWRITE',
  'REGEX_DECODE_CHAIN',
  'REGEX_JAVASCRIPT_COUPLED',
  'REGEX_DYNAMIC_PATTERN',
  'UNKNOWN_REGEX_USE',
]);
const MAX_CALL_BYTES = 4096;
const CALL_PATTERN = /\b(re\.(?:compile|findall|finditer|match|search|sub)|scrapertools\.(?:find_multiple_matches|find_single_match|get_match))\s*\(/gi;

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const unique = (values) => [...new Set(values)].sort();

const readInvocation = (source, openingIndex) => {
  let depth = 0; let quote = null; let escaped = false;
  const endLimit = Math.min(source.length, openingIndex + MAX_CALL_BYTES);
  for (let index = openingIndex; index < endLimit; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingIndex + 1, index);
    }
  }
  return null;
};

const splitArguments = (invocation) => {
  if (typeof invocation !== 'string') return [];
  const values = []; let start = 0; let depth = 0; let quote = null; let escaped = false;
  for (let index = 0; index < invocation.length; index += 1) {
    const character = invocation[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      values.push(invocation.slice(start, index).trim()); start = index + 1;
    }
  }
  values.push(invocation.slice(start).trim());
  return values;
};

const isStaticString = (value) => {
  const source = String(value).trim();
  const start = source.match(/^(?:[rub]{0,2})?('|")/i);
  if (!start) return false;
  const quote = start[1]; let escaped = false;
  for (let index = start[0].length; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === quote) return source.slice(index + 1).trim() === '';
  }
  return false;
};
const countCaptureGroups = (pattern) => {
  if (!isStaticString(pattern)) return null;
  const literal = String(pattern).replace(/^(?:[rub]{0,2})?/i, '');
  let count = 0; let escaped = false; let characterClass = false;
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '[') { characterClass = true; continue; }
    if (character === ']') { characterClass = false; continue; }
    if (character === '(' && !characterClass && literal[index + 1] !== '?') count += 1;
    if (character === '(' && !characterClass && literal.slice(index + 1, index + 4) === '?P<') {
      count += 1;
    }
  }
  return count;
};

const patternArgumentFor = (name, args) => name.startsWith('scrapertools.') ? args[1] : args[0];
const contextAround = (source, index) => source.slice(Math.max(0, index - 320),
  Math.min(source.length, index + 640));

const classifyRegexUse = ({ name, args, context }) => {
  const pattern = patternArgumentFor(name, args);
  const staticPattern = isStaticString(pattern);
  const explicitlyDynamic = !staticPattern &&
    /^(?:f(?:'|\")|.*(?:\+|%|\.format\s*\(|\.join\s*\(|\[[^\]]+\]|\w+\s*\())/i
      .test(String(pattern).trim());
  const captures = countCaptureGroups(pattern);
  const signals = [];
  if (name === 're.sub') signals.push('substitution');
  if (/base64|b64decode|unicode_escape|html\.unescape|unescape\s*\(|entity|decodeURIComponent/i.test(context)) {
    signals.push('decode_chain');
  }
  if (/jsunpack|javascript|\beval\s*\(|execjs|deobfuscat|packed/i.test(context)) {
    signals.push('javascript_transform');
  }
  if (explicitlyDynamic) signals.push('dynamic_pattern');
  else if (!staticPattern) signals.push('unresolved_pattern_reference');
  if (/href|src|data[-_][a-z0-9_-]+|iframe|<\/?[a-z][^>]*>/i.test(String(pattern))) {
    signals.push('html_attribute');
  }
  if (/script|text|content|title|description/i.test(context)) signals.push('embedded_text');
  if (captures !== null && captures > 1) signals.push('multiple_captures');
  if (captures === 1) signals.push('single_capture');

  let category = 'UNKNOWN_REGEX_USE';
  if (signals.includes('javascript_transform')) category = 'REGEX_JAVASCRIPT_COUPLED';
  else if (signals.includes('decode_chain')) category = 'REGEX_DECODE_CHAIN';
  else if (signals.includes('substitution')) category = 'REGEX_REWRITE';
  else if (signals.includes('dynamic_pattern')) category = 'REGEX_DYNAMIC_PATTERN';
  else if (signals.includes('multiple_captures')) category = 'REGEX_MULTI_CAPTURE';
  else if (signals.includes('html_attribute')) category = 'REGEX_ATTRIBUTE_EXTRACTION';
  else if (signals.includes('embedded_text')) category = 'REGEX_TEXT_CAPTURE';
  else if (signals.includes('single_capture')) category = 'REGEX_SIMPLE_CAPTURE';

  const mappings = {
    REGEX_ATTRIBUTE_EXTRACTION: ['html_selector_attribute', null,
      'ATTRIBUTE_CAN_USE_EXISTING_HTML_SELECTOR'],
    REGEX_TEXT_CAPTURE: [null, 'bounded_text_capture', 'BOUNDED_TEXT_EXTRACTION_REQUIRED'],
    REGEX_SIMPLE_CAPTURE: [null, 'safe_regex_single_capture', 'STATIC_SINGLE_CAPTURE_REQUIRED'],
    REGEX_MULTI_CAPTURE: [null, 'multi_value_extract', 'COORDINATED_CAPTURES_REQUIRED'],
    REGEX_REWRITE: [null, 'bounded_rewrite', 'VALUE_REWRITE_REQUIRED'],
    REGEX_DECODE_CHAIN: [null, 'bounded_decode_chain', 'POST_CAPTURE_DECODE_REQUIRED'],
    REGEX_JAVASCRIPT_COUPLED: [null, 'javascript_transform', 'JAVASCRIPT_COUPLING_DETECTED'],
    REGEX_DYNAMIC_PATTERN: [null, 'static_pattern_contract', 'DYNAMIC_PATTERN_NOT_SAFE'],
    UNKNOWN_REGEX_USE: [null, null, 'INSUFFICIENT_STATIC_EVIDENCE'],
  };
  const [possibleCurrentPrimitive, missingPrimitive, reason] = mappings[category];
  return freeze({ category, observedSignals: unique(signals), possibleCurrentPrimitive,
    missingPrimitive, reason });
};

const detectRegexUses = (source) => {
  const uses = []; const matcher = new RegExp(CALL_PATTERN.source, CALL_PATTERN.flags);
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const invocation = readInvocation(source, matcher.lastIndex - 1);
    const args = splitArguments(invocation);
    uses.push(classifyRegexUse({ name: match[1].toLowerCase(), args,
      context: contextAround(source, match.index) }));
  }
  return uses;
};

const groupUses = (channel, uses) => {
  const groups = new Map();
  for (const use of uses) {
    const current = groups.get(use.category) || { count: 0, signals: new Set(), sample: use };
    current.count += 1;
    for (const signal of use.observedSignals) current.signals.add(signal);
    groups.set(use.category, current);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([category, group]) => freeze({ channel, category, count: group.count,
      observedSignals: [...group.signals].sort(),
      possibleCurrentPrimitive: group.sample.possibleCurrentPrimitive,
      missingPrimitive: group.sample.missingPrimitive, reason: group.sample.reason }));
};

const reductionBucket = (records) => {
  const categories = new Set(records.map(({ category }) => category));
  if (categories.has('REGEX_JAVASCRIPT_COUPLED')) return 'javascript';
  if (categories.has('REGEX_DECODE_CHAIN') || categories.has('REGEX_REWRITE')) {
    return 'rewriteOrDecode';
  }
  if (categories.has('REGEX_DYNAMIC_PATTERN') || categories.has('UNKNOWN_REGEX_USE')) {
    return 'unknown';
  }
  if (categories.has('REGEX_MULTI_CAPTURE') || categories.has('REGEX_SIMPLE_CAPTURE')) {
    return 'safeRegexCapture';
  }
  if (categories.has('REGEX_TEXT_CAPTURE')) return 'boundedTextCapture';
  if (categories.size && [...categories].every((value) =>
    value === 'REGEX_ATTRIBUTE_EXTRACTION')) return 'existingPrimitives';
  return 'unknown';
};

const candidateComponentsFor = (records) => {
  const byCategory = new Map();
  for (const record of records) {
    if (!byCategory.has(record.category)) byCategory.set(record.category, new Set());
    byCategory.get(record.category).add(record.channel);
  }
  const component = (id, categories, requiredFeatures, forbiddenFeatures) => {
    const affectedChannels = unique(categories.flatMap((category) =>
      [...(byCategory.get(category) || [])]));
    return affectedChannels.length ? freeze({ id, affectedChannels, requiredFeatures,
      forbiddenFeatures }) : null;
  };
  return [
    component('bounded_text_capture', ['REGEX_TEXT_CAPTURE'],
      ['bounded_input', 'bounded_output', 'static_delimiters'],
      ['dynamic_patterns', 'execution', 'replacement']),
    component('safe_regex_single_capture', ['REGEX_SIMPLE_CAPTURE'],
      ['bounded_input', 'bounded_output', 'one_capture_group', 'static_pattern'],
      ['dynamic_patterns', 'execution', 'replacement', 'output_backreferences']),
    component('multi_value_extract', ['REGEX_MULTI_CAPTURE'],
      ['bounded_input', 'bounded_output', 'finite_named_fields', 'static_pattern'],
      ['dynamic_patterns', 'execution', 'replacement']),
  ].filter(Boolean);
};

const directMp4Role = (source, channel) => {
  const signals = [];
  if (/\.m3u8|mpegurl/i.test(source)) signals.push('also_hls');
  if (/download_(?:url|link)|def\s+download\b|descarga|guardar|save_file/i.test(source)) {
    signals.push('download_semantics');
  }
  if (/fallback|alternate|alternative|backup/i.test(source)) signals.push('fallback_semantics');
  const role = signals.includes('download_semantics') ? 'DOWNLOAD_LINK'
    : signals.includes('fallback_semantics') ? 'FALLBACK'
      : signals.includes('also_hls') ? 'SOURCE_ALONGSIDE_HLS' : 'FINAL_DIRECT_OUTPUT';
  return freeze({ channel, role, observedSignals: signals.sort() });
};

const scanChannelRegexGap = ({ root, coverage = null } = {}) => {
  const channelCoverage = coverage || scanTopLevelChannelCoverageV2({ root });
  const folder = path.basename(path.resolve(root)).toLowerCase() === 'channels'
    ? path.resolve(root) : path.join(path.resolve(root), 'channels');
  const eligible = channelCoverage.channels.filter(({ missingCapabilities }) =>
    missingCapabilities.includes('html_regex_transform'));
  const records = []; const recordsByChannel = new Map();
  for (const channel of eligible) {
    const source = fs.readFileSync(path.join(folder, `${channel.channel}.py`), 'utf8');
    const grouped = groupUses(channel.channel, detectRegexUses(source));
    records.push(...grouped); recordsByChannel.set(channel.channel, grouped);
  }
  const byRegexUse = Object.fromEntries(REGEX_USE_CATEGORIES.map((category) =>
    [category, records.filter((record) => record.category === category)
      .reduce((sum, record) => sum + record.count, 0)]));
  const hypotheticalReduction = { currentGap: eligible.length, existingPrimitives: 0,
    boundedTextCapture: 0, safeRegexCapture: 0, rewriteOrDecode: 0, javascript: 0,
    unknown: 0 };
  for (const channel of eligible) {
    hypotheticalReduction[reductionBucket(recordsByChannel.get(channel.channel) || [])] += 1;
  }
  const proxyOrGeoOverlap = eligible.filter(({ missingCapabilities }) =>
    missingCapabilities.includes('proxy_or_geo')).map(({ channel }) => channel).sort();
  const directMp4 = channelCoverage.channels.filter(({ sourceSignals }) =>
    sourceSignals.includes('direct_mp4')).map(({ channel }) => {
    const source = fs.readFileSync(path.join(folder, `${channel}.py`), 'utf8');
    return directMp4Role(source, channel);
  });
  const unknownChannels = channelCoverage.channels.filter(({ assessment }) =>
    assessment === 'UNKNOWN').map(({ channel }) => channel).sort();
  return freeze({ runtimeCommit: channelCoverage.runtimeCommit,
    population: { coverageChannels: channelCoverage.population.channels,
      currentGapChannels: eligible.length, regexUseRecords: records.length,
      regexUses: Object.values(byRegexUse).reduce((sum, count) => sum + count, 0) },
    byRegexUse, hypotheticalReduction, candidateComponents: candidateComponentsFor(records),
    proxyOrGeoOverlap, directMp4, unknownChannels, records });
};

module.exports = {
  REGEX_USE_CATEGORIES,
  classifyRegexUse,
  detectRegexUses,
  scanChannelRegexGap,
};
