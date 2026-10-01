'use strict';

const net = require('node:net');

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const normalizePublicDomains = (value, maximum = 16) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return null;
  const output = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const domain = item.trim().toLowerCase();
    if (!DOMAIN.test(domain) || net.isIP(domain) || domain === 'localhost' ||
        domain.endsWith('.localhost') || /[*:/?#@]/.test(domain)) return null;
    if (!output.includes(domain)) output.push(domain);
  }
  return output;
};

const hostnameMatches = (hostname, domains) => domains.some((domain) =>
  hostname === domain || hostname.endsWith(`.${domain}`));

const urlMatchesDomains = (value, domains) => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol) &&
      hostnameMatches(url.hostname.toLowerCase(), domains);
  } catch { return false; }
};

module.exports = { hostnameMatches, normalizePublicDomains, urlMatchesDomains };
