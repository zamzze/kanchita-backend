'use strict';

const normalizeTitle = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase('es');

const matchingScore = (input, candidate) => {
  const inputTmdb = String(input.tmdbId || '');
  const candidateTmdb = String(candidate.tmdbId || '');
  if (inputTmdb && candidateTmdb) return inputTmdb === candidateTmdb ? 300 : -1;

  const inputImdb = String(input.imdbId || '').toLowerCase();
  const candidateImdb = String(candidate.imdbId || '').toLowerCase();
  if (inputImdb && candidateImdb) return inputImdb === candidateImdb ? 200 : -1;

  if (!input.title || !candidate.title ||
    normalizeTitle(input.title) !== normalizeTitle(candidate.title)) return -1;
  if (input.year && candidate.year && Number(input.year) !== Number(candidate.year)) return -1;
  if (input.contentType === 'episode') {
    if (Number(input.season) !== Number(candidate.season) ||
      Number(input.episode) !== Number(candidate.episode)) return -1;
  }
  return 100;
};

const selectProviderMatch = (input, candidates = []) => candidates
  .map((candidate) => ({ candidate, score: matchingScore(input, candidate) }))
  .filter(({ score }) => score >= 0)
  .sort((left, right) => right.score - left.score)[0]?.candidate || null;

module.exports = { matchingScore, normalizeTitle, selectProviderMatch };
