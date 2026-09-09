'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPrimaryRolloutGate } =
  require('../src/modules/streams/resolverV2/primaryRolloutGate');

const movie = (id) => ({ contentType: 'movie', contentId: id, tmdbId: 1, title: 'Ignored' });
const episode = (id) => ({ contentType: 'episode', contentId: id, tmdbId: 2,
  title: 'Ignored', season: 1, episode: 2 });
const gate = (rolloutPercent, options = {}) => createPrimaryRolloutGate({
  enabled: true, rolloutPercent, seed: 'stable-seed', ...options,
});

test('disabled, media gates and boundary percentages fail closed', () => {
  assert.equal(createPrimaryRolloutGate().evaluate(movie('a')).reason, 'primary_disabled');
  assert.equal(gate(0).evaluate(movie('a')).reason, 'rollout_zero');
  assert.equal(gate(100).evaluate(movie('a')).reason, 'selected');
  assert.equal(gate(100, { moviesEnabled: false }).evaluate(movie('a')).reason,
    'movie_disabled');
  assert.equal(gate(100, { episodesEnabled: false }).evaluate(episode('a')).reason,
    'episode_disabled');
  assert.equal(gate(100).evaluate({ contentType: 'unknown' }).reason, 'invalid_context');
});

test('sampling buckets are stable across instances, percentages and request order', () => {
  const first = gate(10);
  const second = gate(80);
  const contexts = Array.from({ length: 100 }, (_, index) => movie(`movie-${index}`));
  const forward = contexts.map((context) => first.evaluate(context).bucket);
  const reverse = [...contexts].reverse().map((context) => first.evaluate(context).bucket).reverse();
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, contexts.map((context) => second.evaluate(context).bucket));
  assert.equal(first.evaluate(movie('stable')).bucket, first.evaluate({
    ...movie('stable'), title: 'A different title',
  }).bucket);
  const changed = createPrimaryRolloutGate({ enabled: true, rolloutPercent: 10,
    seed: 'different-seed' });
  assert.ok(contexts.some((context, index) => changed.evaluate(context).bucket !== forward[index]));
});

test('fixed-seed cohorts are monotonic', () => {
  const contexts = Array.from({ length: 2_000 }, (_, index) => movie(`movie-${index}`));
  const cohorts = [10, 20, 50, 100].map((percent) => new Set(contexts
    .filter((context) => gate(percent).evaluate(context).eligible)
    .map((context) => context.contentId)));
  for (let index = 0; index < cohorts.length - 1; index += 1) {
    for (const id of cohorts[index]) assert.equal(cohorts[index + 1].has(id), true);
  }
});

test('ten percent rollout has a reasonable deterministic distribution', () => {
  let selected = 0;
  for (let index = 0; index < 10_000; index += 1) {
    if (gate(10).evaluate(movie(`movie-${index}`)).eligible) selected += 1;
  }
  assert.ok(selected >= 900 && selected <= 1100, `selected=${selected}`);
});

test('rollout implementation has no randomness or user-derived sampling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'primaryRolloutGate.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random|userId|email|requestId|process\.pid/);
});
test('rollout summaries expose no content identity', () => {
  const result = gate(10).evaluate(movie('private-content'));
  assert.ok(Number.isInteger(result.bucket) && result.bucket >= 0 && result.bucket < 10_000);
  assert.doesNotMatch(JSON.stringify(result), /private-content|contentId|tmdbId|title|https?:|token/i);
});
