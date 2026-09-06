'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IPV4_BLOCKS = [
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
];

const validationError = (code) => {
  const error = new Error(code);
  error.validationCode = code;
  return error;
};

const parseHttpUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
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
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
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
    return !IPV4_BLOCKS.some(([network, prefix]) =>
      ipv4InCidr(address, network, prefix)
    );
  }
  if (family !== 6) return false;

  const value = parseIpv6(address);
  if (value === null) return false;

  // IPv4-mapped IPv6 is evaluated using the embedded IPv4 policy.
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn) >>> 0;
    return isPublicIp([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join('.'));
  }

  // Fail closed: ordinary public IPv6 destinations must be global unicast.
  if (!ipv6InCidr(value, '2000::', 3)) return false;

  // Special-purpose ranges inside global unicast are not acceptable targets.
  return ![
    ['2001::', 32],       // Teredo
    ['2001:2::', 48],     // benchmarking
    ['2001:10::', 28],    // ORCHID (deprecated)
    ['2001:20::', 28],    // ORCHIDv2
    ['2001:db8::', 32],   // documentation
    ['2002::', 16],       // 6to4 transition addresses
  ].some(([network, prefix]) => ipv6InCidr(value, network, prefix));
};

const hostnameWithoutBrackets = (hostname) =>
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

const isLocalhostName = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
};

const resolveDestination = async (url, {
  dnsLookup = dns.lookup,
  allowPrivateNetworks = false,
} = {}) => {
  const hostname = hostnameWithoutBrackets(url.hostname);
  const literalFamily = net.isIP(hostname);

  if (!allowPrivateNetworks && isLocalhostName(hostname)) {
    throw validationError('HLS_UNSAFE_DESTINATION');
  }

  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
      throw validationError('HLS_UNSAFE_DESTINATION');
    }
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw validationError('HLS_UNSAFE_DESTINATION');
  }

  const normalized = addresses.map((entry) => ({
    address: entry.address,
    family: Number(entry.family) || net.isIP(entry.address),
  }));
  if (normalized.some(({ address, family }) =>
    !family || (!allowPrivateNetworks && !isPublicIp(address))
  )) {
    throw validationError('HLS_UNSAFE_DESTINATION');
  }
  return normalized;
};

const pinnedLookup = (addresses) => (hostname, options, callback) => {
  if (options?.all) return callback(null, addresses);
  const selected = addresses[0];
  return callback(null, selected.address, selected.family);
};

const requestManifest = (url, { addresses, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const request = transport.request(url, {
      method: 'GET',
      agent: false,
      lookup: pinnedLookup(addresses),
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.8',
      },
    });

    timeout = setTimeout(() => {
      request.destroy(validationError('HLS_TIMEOUT'));
    }, timeoutMs);
    request.on('error', (error) => finish(reject, error));
    request.on('response', (response) => {
      const location = response.headers.location || null;
      if (REDIRECT_STATUSES.has(response.statusCode) ||
          response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        finish(resolve, { status: response.statusCode, location, body: null });
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        finish(reject, validationError('HLS_TOO_LARGE'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(validationError('HLS_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode,
        location,
        body: Buffer.concat(chunks, total),
      }));
      response.on('error', (error) => finish(reject, error));
    });
    request.end();
  });

const withDeadline = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(validationError('HLS_TIMEOUT')),
    timeoutMs
  );
  promise.then(
    (value) => {
      clearTimeout(timeout);
      resolve(value);
    },
    (error) => {
      clearTimeout(timeout);
      reject(error);
    }
  );
});

const createHlsValidator = ({
  timeoutMs = 5000,
  maxBytes = 256 * 1024,
  maxRedirects = 3,
  dnsLookup = dns.lookup,
  requestImpl = requestManifest,
  allowPrivateNetworks = false,
  includeManifest = false,
} = {}) => async (candidate) => {
  let currentUrl = parseHttpUrl(candidate);
  if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };
  const deadline = Date.now() + timeoutMs;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1) throw validationError('HLS_TIMEOUT');
      const addresses = await withDeadline(
        resolveDestination(currentUrl, { dnsLookup, allowPrivateNetworks }),
        remainingMs
      );
      const requestRemainingMs = deadline - Date.now();
      if (requestRemainingMs < 1) throw validationError('HLS_TIMEOUT');
      const response = await requestImpl(currentUrl, {
        addresses,
        timeoutMs: requestRemainingMs,
        maxBytes,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          return { valid: false, code: 'HLS_TOO_MANY_REDIRECTS' };
        }
        if (!response.location) return { valid: false, code: 'HLS_HTTP_ERROR' };
        currentUrl = parseHttpUrl(new URL(response.location, currentUrl).toString());
        if (!currentUrl) return { valid: false, code: 'HLS_INVALID_URL' };
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return { valid: false, code: 'HLS_HTTP_ERROR' };
      }

      const manifest = (response.body || Buffer.alloc(0)).toString('utf8').trimStart();
      if (!manifest.startsWith('#EXTM3U')) {
        return { valid: false, code: 'HLS_INVALID_MANIFEST' };
      }
      return {
        valid: true,
        code: null,
        ...(includeManifest ? { manifest } : {}),
      };
    }
  } catch (error) {
    if (error.validationCode) return { valid: false, code: error.validationCode };
    return { valid: false, code: 'HLS_CONNECTION_ERROR' };
  }
};

module.exports = {
  createHlsValidator,
  isPublicIp,
  parseHttpUrl,
  resolveDestination,
};
