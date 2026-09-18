'use strict';

const PLUTO_OBJECT_ID = /^[a-f0-9]{24}$/i;

const normalizeRecord = (record, { providerId, region }) => {
  let title;
  let year;
  let externalId;
  let tmdbId;
  let matchMethod = null;
  if (Array.isArray(record)) {
    if (record.length !== 4) return null;
    [title, year, externalId, tmdbId] = record;
  } else if (record && typeof record === 'object') {
    title = record.movie;
    year = record.year;
    externalId = record.pluto_id;
    tmdbId = record.tmdb_id;
    matchMethod = typeof record.match === 'string' && record.match.trim()
      ? record.match.trim() : null;
  } else return null;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 512 ||
      !Number.isInteger(tmdbId) || tmdbId < 1 ||
      (year != null && (!Number.isInteger(year) || year < 1888 || year > 2200)) ||
      typeof externalId !== 'string' || !PLUTO_OBJECT_ID.test(externalId.trim())) return null;
  return Object.freeze({ providerId, region, contentType: 'movie', tmdbId,
    externalId: externalId.trim().toLowerCase(), providerTitle: title.trim(),
    matchMethod, status: 'active', metadata: year == null ? {} : { year } });
};

const prepareImport = (payload, { providerId = 'pluto', region = 'latam' } = {}) => {
  const records = Array.isArray(payload) && payload.length === 4 &&
      !payload.some((item) => item && typeof item === 'object') ? [payload]
    : Array.isArray(payload) ? payload : [payload];
  const accepted = new Map();
  const conflicts = new Set();
  let invalid = 0;
  for (const record of records) {
    const mapping = normalizeRecord(record, { providerId, region });
    if (!mapping) { invalid += 1; continue; }
    const identity = `${mapping.providerId}:${mapping.region}:${mapping.contentType}:${mapping.externalId}`;
    const previous = accepted.get(identity);
    if (previous && previous.tmdbId !== mapping.tmdbId) {
      conflicts.add(identity);
      accepted.delete(identity);
      continue;
    }
    if (!conflicts.has(identity) && !previous) accepted.set(identity, mapping);
  }
  return Object.freeze({ input: records.length, invalid,
    conflicts: conflicts.size, mappings: Object.freeze([...accepted.values()]) });
};

const applyImport = async ({ prepared, store, dryRun = true }) => {
  const summary = { input: prepared.input, valid: prepared.mappings.length,
    invalid: prepared.invalid, inserted: 0, updated: 0, unchanged: 0,
    conflicts: prepared.conflicts };
  if (dryRun) return Object.freeze(summary);
  for (const mapping of prepared.mappings) {
    const result = await store.upsertMapping(mapping);
    if (['inserted', 'updated', 'unchanged'].includes(result?.change)) {
      summary[result.change] += 1;
    } else if (result?.change === 'conflict') {
      summary.conflicts += 1;
    }
  }
  return Object.freeze(summary);
};

module.exports = { PLUTO_OBJECT_ID, applyImport, normalizeRecord, prepareImport };
