'use strict';

const { normalizeEmbedCandidate, normalizeStreamCandidate } = require('./resolverContracts');

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeResolverNodeResult = (value) => {
  const input = Array.isArray(value) ? { streams: value, nextCandidates: [] } : value;
  if (!isPlainObject(input) || (input.streams !== undefined && !Array.isArray(input.streams)) ||
      (input.nextCandidates !== undefined && !Array.isArray(input.nextCandidates))) return null;
  const streams = (input.streams || []).map(normalizeStreamCandidate).filter(Boolean);
  const nextCandidates = (input.nextCandidates || []).map(normalizeEmbedCandidate).filter(Boolean);
  return Object.freeze({
    streams: Object.freeze(streams),
    nextCandidates: Object.freeze(nextCandidates),
  });
};

module.exports = { normalizeResolverNodeResult };
