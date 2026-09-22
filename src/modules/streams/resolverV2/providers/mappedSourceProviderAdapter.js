'use strict';

const { normalizeIdentity } = require('../../providerMediaMappingResolver');
const { normalizeSourceProvider } = require('../sourceProviderRegistry');

const DEFAULT_MAX_MAPPING_ATTEMPTS = 3;
const HARD_MAX_MAPPING_ATTEMPTS = 8;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REGION = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const adapterError = (code) => Object.assign(new Error(code), { code });

const createMappedSourceProviderAdapter = ({
  provider,
  mappingResolver,
  providerId,
  region,
  maxMappingAttempts = DEFAULT_MAX_MAPPING_ATTEMPTS,
} = {}) => {
  let normalizedProvider;
  try {
    normalizedProvider = normalizeSourceProvider(provider);
  } catch {
    throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_PROVIDER');
  }
  if (!mappingResolver || typeof mappingResolver.resolve !== 'function') {
    throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_MAPPING_RESOLVER');
  }
  const descriptorId = normalizedProvider.descriptor.id;
  const configuredProviderId = providerId === undefined ? descriptorId
    : typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const normalizedRegion = typeof region === 'string' ? region.trim().toLowerCase() : '';
  if (!PROVIDER_ID.test(configuredProviderId) || configuredProviderId !== descriptorId) {
    throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_PROVIDER_ID');
  }
  if (!REGION.test(normalizedRegion)) {
    throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_REGION');
  }
  if (!Number.isInteger(maxMappingAttempts) || maxMappingAttempts < 1 ||
      maxMappingAttempts > HARD_MAX_MAPPING_ATTEMPTS) {
    throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_MAX_MAPPING_ATTEMPTS');
  }

  const getSources = async (mediaContext, runtime = {}) => {
    const identity = normalizeIdentity({
      providerId: descriptorId,
      region: normalizedRegion,
      mediaContext,
    });
    if (!identity) return Object.freeze([]);
    const refs = await mappingResolver.resolve({
      providerId: descriptorId,
      region: normalizedRegion,
      mediaContext,
    });
    if (!Array.isArray(refs) || refs.length === 0) return Object.freeze([]);
    for (const providerMediaRef of refs.slice(0, maxMappingAttempts)) {
      const candidates = await normalizedProvider.getSources(mediaContext, {
        ...runtime,
        providerMediaRef,
      });
      if (!Array.isArray(candidates)) {
        throw adapterError('MAPPED_SOURCE_PROVIDER_INVALID_RESULT');
      }
      if (candidates.length > 0) return candidates;
    }
    return Object.freeze([]);
  };

  return Object.freeze({
    descriptor: normalizedProvider.descriptor,
    getSources,
  });
};

module.exports = {
  DEFAULT_MAX_MAPPING_ATTEMPTS,
  HARD_MAX_MAPPING_ATTEMPTS,
  createMappedSourceProviderAdapter,
};
