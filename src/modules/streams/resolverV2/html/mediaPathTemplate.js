'use strict';

const PLACEHOLDERS = new Set(['tmdbId', 'season', 'episode']);
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i;

const normalizeMediaPathTemplate = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512 ||
      value.includes('\0') || value.includes('\\') || value.includes('://') ||
      value.startsWith('//') || /(?:^|\/)\.\.(?:\/|$)/.test(value) || ENCODED_TRAVERSAL.test(value)) {
    return null;
  }
  const matches = [...value.matchAll(/\{([^{}]+)\}/g)];
  const withoutPlaceholders = value.replace(/\{[^{}]+\}/g, '');
  if (matches.some((match) => !PLACEHOLDERS.has(match[1])) ||
      withoutPlaceholders.includes('{') || withoutPlaceholders.includes('}')) return null;
  return value;
};

const renderMediaPath = (template, mediaContext, baseUrl) => {
  const normalized = normalizeMediaPathTemplate(template);
  if (!normalized || !mediaContext || typeof mediaContext !== 'object') return null;
  let path = normalized;
  for (const match of normalized.matchAll(/\{([^{}]+)\}/g)) {
    const value = mediaContext[match[1]];
    if (!Number.isInteger(value) || value < 0) return null;
    path = path.replaceAll(match[0], String(value));
  }
  try {
    const base = new URL(baseUrl);
    const result = new URL(path, base.origin);
    return result.origin === base.origin ? result.toString() : null;
  } catch { return null; }
};

module.exports = { normalizeMediaPathTemplate, renderMediaPath };
