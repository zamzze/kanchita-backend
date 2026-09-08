'use strict';

const normalizedUrlIdentity = (rawUrl) => {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.toString();
};

const candidateIdentity = (candidate) => {
  const referer = candidate.referer || candidate.headers?.referer || '';
  const origin = candidate.origin || candidate.headers?.origin || '';
  return JSON.stringify([
    candidate.providerId,
    normalizedUrlIdentity(candidate.url),
    referer ? normalizedUrlIdentity(referer) : '',
    origin ? normalizedUrlIdentity(origin) : '',
  ]);
};

module.exports = { candidateIdentity, normalizedUrlIdentity };
