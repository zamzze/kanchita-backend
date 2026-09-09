'use strict';

const crypto = require('node:crypto');
const { normalizeMediaContext } = require('./resolverContracts');

const BUCKET_COUNT = 10_000;
const REASONS = Object.freeze([
  'primary_disabled', 'movie_disabled', 'episode_disabled', 'rollout_zero',
  'rollout_not_selected', 'runtime_guard_open', 'selected', 'invalid_context',
]);

const createPrimaryRolloutGate = ({
  enabled = false,
  rolloutPercent = 0,
  seed = 'kanchita-v2',
  moviesEnabled = true,
  episodesEnabled = true,
} = {}) => {
  if (typeof enabled !== 'boolean' || typeof moviesEnabled !== 'boolean' ||
      typeof episodesEnabled !== 'boolean' || !Number.isInteger(rolloutPercent) ||
      rolloutPercent < 0 || rolloutPercent > 100 || typeof seed !== 'string' ||
      seed.length < 1 || seed.length > 128) {
    throw Object.assign(new Error('PRIMARY_ROLLOUT_INVALID_CONFIG'), {
      code: 'PRIMARY_ROLLOUT_INVALID_CONFIG',
    });
  }

  const bucketFor = (mediaContext) => {
    const identity = `${seed}|${mediaContext.contentType}|${mediaContext.contentId}`;
    return crypto.createHash('sha256').update(identity).digest().readUInt32BE(0) % BUCKET_COUNT;
  };

  const result = (eligible, reason, bucket = 0) => Object.freeze({
    eligible, reason, bucket,
  });

  const evaluate = (input) => {
    if (!enabled) return result(false, 'primary_disabled');
    const mediaContext = normalizeMediaContext(input);
    if (!mediaContext) return result(false, 'invalid_context');
    if (mediaContext.contentType === 'movie' && !moviesEnabled) {
      return result(false, 'movie_disabled');
    }
    if (mediaContext.contentType === 'episode' && !episodesEnabled) {
      return result(false, 'episode_disabled');
    }
    if (rolloutPercent === 0) return result(false, 'rollout_zero');
    const bucket = bucketFor(mediaContext);
    return bucket < rolloutPercent * 100
      ? result(true, 'selected', bucket)
      : result(false, 'rollout_not_selected', bucket);
  };

  return Object.freeze({ evaluate, reasons: REASONS });
};

module.exports = { BUCKET_COUNT, REASONS, createPrimaryRolloutGate };
