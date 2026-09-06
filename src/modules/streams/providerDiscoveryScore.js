'use strict';

const WEIGHTS = Object.freeze({
  directHls: 500,
  documentedApi: 300,
  noBrowser: 300,
  quality1080p: 150,
  quality720p: 75,
  es419Audio: 100,
  esAudio: 60,
  spanishSubtitles: 30,
  clean: 300,
  knownExpiry: 50,
  tmdbLookup: 100,
  imdbLookup: 75,
  browserRequired: -300,
  unknownAds: -100,
  adMarked: -500,
  unstableDomain: -200,
  unknownRights: -500,
  privateEndpoint: -1000,
  drm: -10000,
});

const EXCLUSIONS = Object.freeze([
  'drm', 'privateEndpoint', 'antiBotBypass', 'credentialSharing', 'unknownRights',
  'unclearRights',
]);

const scoreProviderProfile = (profile = {}) => {
  const score = Object.entries(WEIGHTS).reduce(
    (total, [attribute, weight]) => total + (profile[attribute] ? weight : 0), 0
  );
  const excludedBy = EXCLUSIONS.filter((attribute) => profile[attribute]);
  return { score, eligible: excludedBy.length === 0, excludedBy };
};

module.exports = { EXCLUSIONS, WEIGHTS, scoreProviderProfile };
