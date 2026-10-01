'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const IPV4_BLOCKS = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

const networkError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const parseHttpUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
};

const ipv4ToInteger = (address) => address
  .split('.')
  .reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);

const ipv4InCidr = (address, network, prefix) => {
  const value = ipv4ToInteger(address);
  const base = ipv4ToInteger(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
};

const parseIpv6 = (address) => {
  let normalized = address.toLowerCase();
  if (normalized.includes('%')) return null;

  const ipv4Match = normalized.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (ipv4Match) {
    if (net.isIP(ipv4Match[1]) !== 4) return null;
    const value = ipv4ToInteger(ipv4Match[1]);
    normalized = normalized.slice(0, -ipv4Match[1].length) +
      `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

const ipv6InCidr = (value, network, prefix) => {
  const base = parseIpv6(network);
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (base >> shift);
};

const isPublicIp = (address) => {
  const family = net.isIP(address);
  if (family === 4) {
    return !IPV4_BLOCKS.some(([network, prefix]) => ipv4InCidr(address, network, prefix));
  }
  if (family !== 6) return false;

  const value = parseIpv6(address);
  if (value === null) return false;
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn) >>> 0;
    return isPublicIp([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join('.'));
  }

  if (!ipv6InCidr(value, '2000::', 3)) return false;
  return ![
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['2002::', 16],
  ].some(([network, prefix]) => ipv6InCidr(value, network, prefix));
};

const hostnameWithoutBrackets = (hostname) =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const isLocalhostName = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
};

const normalizeDnsAddresses = (addresses) => addresses.map((entry) => ({
  address: entry.address,
  family: Number(entry.family) || net.isIP(entry.address),
}));

const resolveDestination = async (url, {
  dnsLookup = dns.lookup,
  allowPrivateNetworks = false,
  unsafeCode = 'HTTP_UNSAFE_DESTINATION',
} = {}) => {
  const hostname = hostnameWithoutBrackets(url.hostname);
  const literalFamily = net.isIP(hostname);
  if (!allowPrivateNetworks && isLocalhostName(hostname)) throw networkError(unsafeCode);

  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
      throw networkError(unsafeCode);
    }
  }

  if (!Array.isArray(addresses) || addresses.length === 0) throw networkError(unsafeCode);
  const normalized = normalizeDnsAddresses(addresses);
  if (normalized.some(({ address, family }) =>
    !family || (!allowPrivateNetworks && !isPublicIp(address)))) {
    throw networkError(unsafeCode);
  }
  return normalized;
};

const pinnedLookup = (addresses) => (_hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (options?.all) return callback(null, addresses.map((entry) => ({ ...entry })));
  const requestedFamily = Number(options?.family) || 0;
  const selected = addresses.find(({ family }) => !requestedFamily || family === requestedFamily) ||
    addresses[0];
  return callback(null, selected.address, selected.family);
};

const withDeadline = (promise, timeoutMs, {
  timeoutCode = 'HTTP_TIMEOUT',
  signal = null,
} = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(networkError('HTTP_ABORTED'));
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    callback(value);
  };
  const onAbort = () => finish(reject, networkError('HTTP_ABORTED'));
  const timer = setTimeout(() => finish(reject, networkError(timeoutCode)), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  promise.then(
    (value) => finish(resolve, value),
    (error) => finish(reject, error)
  );
});

module.exports = {
  IPV4_BLOCKS,
  isPublicIp,
  parseHttpUrl,
  resolveDestination,
  pinnedLookup,
  withDeadline,
  networkError,
};
