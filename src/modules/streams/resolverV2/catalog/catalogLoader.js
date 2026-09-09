'use strict';

const fs = require('node:fs');
const { normalizeCatalog } = require('./catalogSchema');
const { CATALOG_CODES } = require('./catalogErrors');

const DEFAULT_MAX_BYTES = 256 * 1024;
const REMOTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const emptyResult = (code) => Object.freeze({
  loaded: false,
  version: null,
  sources: Object.freeze([]),
  resolvers: Object.freeze([]),
  summary: Object.freeze({ sourceEntries: 0, resolverEntries: 0,
    validSources: 0, validResolvers: 0, skippedSources: 0, skippedResolvers: 0,
    errorCodes: Object.freeze([code]) }),
});

const loadResolverV2Catalog = ({
  enabled = false,
  filePath = '',
  readFile = fs.readFileSync,
  env = process.env,
  limits,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) => {
  if (enabled !== true) return emptyResult(CATALOG_CODES.DISABLED);
  if (typeof filePath !== 'string' || !filePath.trim() ||
      REMOTE_SCHEME.test(filePath.trim())) return emptyResult(CATALOG_CODES.PATH_MISSING);
  if (typeof readFile !== 'function' || !env || typeof env !== 'object' ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    return emptyResult(CATALOG_CODES.READ_FAILED);
  }
  let raw;
  try {
    raw = readFile(filePath.trim());
  } catch {
    return emptyResult(CATALOG_CODES.READ_FAILED);
  }
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') {
    return emptyResult(CATALOG_CODES.READ_FAILED);
  }
  const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, 'utf8');
  if (size > maxBytes) return emptyResult(CATALOG_CODES.TOO_LARGE);
  const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyResult(CATALOG_CODES.INVALID_JSON);
  }
  let catalog;
  try {
    catalog = normalizeCatalog(parsed, { limits });
  } catch (error) {
    return emptyResult(Object.values(CATALOG_CODES).includes(error?.code)
      ? error.code : CATALOG_CODES.INVALID_ROOT);
  }

  const errors = [...catalog.summary.errorCodes];
  const sources = catalog.sources.filter((entry) => {
    if (!entry.authTokenEnv) return true;
    const present = typeof env[entry.authTokenEnv] === 'string' && env[entry.authTokenEnv].trim().length > 0;
    if (!present) errors.push(CATALOG_CODES.MISSING_SECRET);
    return present;
  });
  const resolvers = catalog.resolvers.filter((entry) => {
    if (!entry.authTokenEnv) return true;
    const present = typeof env[entry.authTokenEnv] === 'string' && env[entry.authTokenEnv].trim().length > 0;
    if (!present) errors.push(CATALOG_CODES.MISSING_SECRET);
    return present;
  });
  return Object.freeze({
    loaded: true,
    version: 1,
    sources: Object.freeze(sources),
    resolvers: Object.freeze(resolvers),
    summary: Object.freeze({
      ...catalog.summary,
      validSources: sources.length,
      validResolvers: resolvers.length,
      skippedSources: catalog.summary.sourceEntries - sources.length,
      skippedResolvers: catalog.summary.resolverEntries - resolvers.length,
      errorCodes: Object.freeze(errors),
    }),
  });
};

module.exports = { DEFAULT_MAX_BYTES, loadResolverV2Catalog };
