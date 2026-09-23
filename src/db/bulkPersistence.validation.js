'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,127}$/;
const HEADER_NAMES = new Set(['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'range']);
const SECRET_KEY = /(?:token|secret|password|credential|authorization|cookie|api.?key|session|signature|signed|jwt)/i;
const SECRET_QUERY = /(?:token|secret|password|credential|authorization|cookie|api.?key|session|signature|sig|expires?|exp|jwt)/i;

const isPlainObject = (value) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const safeJsonObject = (value) => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return null;
  let nodes = 0;
  const copy = (item, depth) => {
    nodes += 1;
    if (nodes > 128 || depth > 5) return undefined;
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined;
    if (typeof item === 'string') {
      return item.length <= 1024 && !/https?:\/\/|bearer\s|eyJ[A-Za-z0-9_-]{20,}/i.test(item)
        ? item : undefined;
    }
    if (Array.isArray(item)) {
      const values = item.map((child) => copy(child, depth + 1));
      return values.every((child) => child !== undefined) ? values : undefined;
    }
    if (!isPlainObject(item)) return undefined;
    const output = Object.create(null);
    for (const [key, child] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' ||
          SECRET_KEY.test(key) || key.length > 64) return undefined;
      const safe = copy(child, depth + 1);
      if (safe === undefined) return undefined;
      output[key] = safe;
    }
    return output;
  };
  return copy(value, 0) ?? null;
};

const safeHeaders = (value) => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).length > HEADER_NAMES.size) return null;
  const headers = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAMES.has(name) || Object.hasOwn(headers, name) ||
        typeof rawValue !== 'string' || rawValue.length > 2048 ||
        /[\r\n]/.test(rawValue) ||
        ((name === 'referer' || name === 'origin') &&
          (!safeHttpUrl(rawValue, false) || SECRET_QUERY.test(new URL(rawValue).search)))) return null;
    headers[name] = rawValue;
  }
  return headers;
};

const safeHttpUrl = (value, allowSigned = false) => {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.hash) return null;
    if (!allowSigned && [...url.searchParams.keys()].some((key) => SECRET_QUERY.test(key))) {
      return null;
    }
    return url.toString();
  } catch { return null; }
};

const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const errorCode = (value) => value === null || typeof value === 'string' && CODE.test(value);
const timestamp = (value) => value == null ? null : value instanceof Date &&
  Number.isFinite(value.getTime()) ? value : typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) ? new Date(value) : undefined;
const shortLabel = (value, length = 128) => value == null ? null :
  typeof value === 'string' && value.length > 0 && value.length <= length &&
  !/[\r\n]/.test(value) ? value : undefined;
const identityHash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const invalid = (code) => Object.assign(new Error(code), { code });

module.exports = { IDENTIFIER, errorCode, identityHash, invalid, isPlainObject,
  positiveId, safeHeaders, safeHttpUrl, safeJsonObject, shortLabel, timestamp, uuid };
