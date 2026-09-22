'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RUNTIME_CONTRACT, assessBoundedTextRequirement, createBoundedTextEquivalence } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiBoundedTextEquivalence');

const exact = { responseBodyOnly: true, literalStaticDelimiters: true };
const assess = (overrides = {}) => assessBoundedTextRequirement({ ...exact, ...overrides });
const payoff = (channels = ['exact']) => ({ channels: channels.map((channel) => ({ channel,
  requiredNewCapabilities: ['bounded_text_capture'] })), candidateSets: [{
  capabilities: ['bounded_text_capture'], fullyUnblocked: channels.length,
  channels: { fullyUnblocked: channels } }] });

test('runtime contract records the audited narrow bounded capture semantics', () => {
  assert.equal(RUNTIME_CONTRACT.parser, 'text');
  assert.equal(RUNTIME_CONTRACT.source, 'previous_response_body');
  assert.equal(RUNTIME_CONTRACT.delimiterMaxChars, 256);
  assert.equal(RUNTIME_CONTRACT.maxCaptureChars, 4096);
  assert.equal(RUNTIME_CONTRACT.regex, false);
  assert.equal(RUNTIME_CONTRACT.scalarVariableChaining, false);
});

test('exact literal response-body capture is equivalent', () => {
  assert.deepEqual(assess(), { assessment: 'EQUIVALENT',
    reason: 'STATIC_LITERAL_SINGLE_RESPONSE_CAPTURE',
    observedRequirements: ['literalStaticDelimiters', 'responseBodyOnly'] });
});

test('scalar chaining and repeated global capture are partial', () => {
  assert.equal(assess({ scalarChaining: true }).assessment, 'PARTIAL');
  assert.equal(assess({ repeatedCapture: true }).assessment, 'PARTIAL');
});

test('regex and decode or rewrite requirements are not equivalent', () => {
  assert.equal(assess({ regexRequired: true }).assessment, 'NOT_EQUIVALENT');
  assert.equal(assess({ decodeOrRewrite: true }).assessment, 'NOT_EQUIVALENT');
});

test('corrected payoff retains only runtime-equivalent predicted unlocks', () => {
  const report = createBoundedTextEquivalence({ payoff: payoff(['exact', 'scalar', 'global',
    'regex', 'decode']), channelSources: {
    exact: '# embedded text\nscrapertools.find_single_match(data, "BEGIN(.*?)END")',
    scalar: '# embedded text\nscrapertools.find_single_match(block, "BEGIN(.*?)END")',
    global: '# embedded text\nscrapertools.find_multiple_matches(data, "BEGIN(.*?)END")',
    regex: '# embedded text\nscrapertools.find_single_match(data, "BEGIN\\s*(.*?)END")',
    decode: '# embedded text\ndata = data.decode("latin1")\n' +
      'scrapertools.find_single_match(data, "A(.*?)Z")',
  } });
  assert.deepEqual(report.summary, { channelsUsingBoundedText: 5, equivalentCount: 1,
    partialCount: 2, notEquivalentCount: 2, unknownCount: 0 });
  assert.deepEqual(report.correctedPayoff.RuntimeEquivalentChannels, ['exact']);
  assert.equal(report.correctedPayoff.exactMatch, false);
});

test('output is deterministic and leaks neither source nor regex patterns', () => {
  const input = { payoff: payoff(['safe']), channelSources: {
    safe: '# embedded text\n' +
      'scrapertools.find_single_match(data, "PRIVATE_START(.*?)PRIVATE_END")' } };
  const first = createBoundedTextEquivalence(input);
  assert.deepEqual(first, createBoundedTextEquivalence(input));
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_START|PRIVATE_END|https?:\/\/|\(\.\*\?\)/);
});

test('diagnostic remains static and isolated from runtime, network and execution', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiBoundedTextEquivalence'), 'utf8');
  assert.doesNotMatch(source,
    /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|puppeteer|dynamic\s+import|new Function|\beval\s*\(/i);
});
