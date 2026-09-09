'use strict';

const {
  normalizeEmbedCandidate,
  normalizeResolverDescriptor,
  normalizeStreamCandidate,
} = require('./resolverContracts');

const registryError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const freezeDescriptor = (descriptor) => Object.freeze({
  ...descriptor,
  protocols: Object.freeze([...descriptor.protocols]),
  domains: Object.freeze([...descriptor.domains]),
  aliases: Object.freeze([...descriptor.aliases]),
  urlPatterns: Object.freeze([...descriptor.urlPatterns]),
});

const normalizeResolver = (resolver) => {
  if (!resolver || typeof resolver !== 'object') throw registryError('INVALID_RESOLVER');
  const descriptor = normalizeResolverDescriptor(resolver.descriptor);
  if (!descriptor || typeof resolver.canResolve !== 'function' ||
      typeof resolver.resolve !== 'function') {
    throw registryError('INVALID_RESOLVER');
  }
  const boundResolve = resolver.resolve.bind(resolver);
  const resolve = async (...args) => {
    const result = await boundResolve(...args);
    if (!Array.isArray(result)) throw registryError('INVALID_RESOLVER_RESULT');
    const candidates = result.map(normalizeStreamCandidate);
    if (candidates.some((candidate) => candidate === null)) {
      throw registryError('INVALID_RESOLVER_RESULT');
    }
    return candidates;
  };
  return Object.freeze({
    descriptor: freezeDescriptor(descriptor),
    canResolve: resolver.canResolve.bind(resolver),
    resolve,
  });
};

const byPriorityThenId = (left, right) =>
  right.descriptor.priority - left.descriptor.priority ||
  left.descriptor.id.localeCompare(right.descriptor.id);

const hostnameMatches = (hostname, rule) => {
  const domain = rule.startsWith('*.') ? rule.slice(2) : rule;
  return hostname === domain || hostname.endsWith(`.${domain}`);
};

const declarativeMatch = (descriptor, url) => {
  const hostRules = [...descriptor.domains, ...descriptor.aliases];
  const hasHostRules = hostRules.length > 0;
  const hasPatterns = descriptor.urlPatterns.length > 0;
  if (!hasHostRules && !hasPatterns) return null;
  const hostMatches = !hasHostRules || hostRules.some((rule) =>
    hostnameMatches(url.hostname.toLowerCase(), rule));
  const patternMatches = !hasPatterns || descriptor.urlPatterns.some((pattern) =>
    url.pathname.startsWith(pattern));
  return hostMatches && patternMatches;
};

const createResolverRegistry = (initialResolvers = []) => {
  if (!Array.isArray(initialResolvers)) throw registryError('INVALID_RESOLVER');
  const entries = new Map();

  const register = (resolver) => {
    const entry = normalizeResolver(resolver);
    const id = entry.descriptor.id;
    if (entries.has(id)) throw registryError('DUPLICATE_RESOLVER_ID');
    entries.set(id, entry);
    return entry;
  };

  const get = (id) => entries.get(id) || null;
  const list = () => [...entries.values()]
    .filter(({ descriptor }) => descriptor.active)
    .sort(byPriorityThenId);

  const detect = (candidate) => {
    const normalized = normalizeEmbedCandidate(candidate);
    if (!normalized) return [];
    let url;
    try {
      url = new URL(normalized.url);
      if (url.username || url.password) return [];
    } catch {
      return [];
    }
    const compatible = list().filter((resolver) => resolver.canResolve(normalized) === true);
    const specific = compatible.filter(({ descriptor }) =>
      declarativeMatch(descriptor, url) === true);
    return specific.length > 0
      ? specific
      : compatible.filter(({ descriptor }) => declarativeMatch(descriptor, url) === null);
  };

  for (const resolver of initialResolvers) register(resolver);
  return Object.freeze({ register, get, list, detect });
};

module.exports = {
  createResolverRegistry,
  declarativeMatch,
  hostnameMatches,
};
