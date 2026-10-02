'use strict';

const SELECTORS = Object.freeze(['iframe.src', 'source.src', 'video.src', 'a.href']);
const SELECTOR_MAP = Object.freeze(Object.fromEntries(
  SELECTORS.map((selector) => selector.split('.')).map(([tag, attribute]) =>
    [tag, Object.freeze({ selector: `${tag}.${attribute}`, attribute })])
));
const DEFAULT_MAX_LINKS = 32;
const HARD_MAX_LINKS = 64;

const decodeEntities = (value) => value.replace(
  /&(?:amp|quot|apos|lt|gt|#39|#\d{1,7}|#x[0-9a-f]{1,6});/gi,
  (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<',
      '&gt;': '>', '&#39;': "'" };
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    const numeric = lower.startsWith('&#x')
      ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric) : entity;
  }
);

const normalizeSelectors = (value, defaults = []) => {
  const input = value === undefined ? defaults : value;
  if (!Array.isArray(input) || input.length > SELECTORS.length) return null;
  const output = [];
  for (const selector of input) {
    if (typeof selector !== 'string' || !SELECTORS.includes(selector.toLowerCase())) return null;
    const normalized = selector.toLowerCase();
    if (!output.includes(normalized)) output.push(normalized);
  }
  return output;
};

const normalizeExtractedUrl = (value, baseUrl) => {
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const parseAttribute = (source, target) => {
  const attributes = source.replace(/^\s*[^\s/>]+/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === target) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return null;
};

const scanTags = (html, visit) => {
  let offset = 0;
  let ignored = null;
  while (offset < html.length) {
    const open = html.indexOf('<', offset);
    if (open < 0) return;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      offset = end < 0 ? html.length : end + 3;
      continue;
    }
    let end = open + 1;
    let quote = null;
    for (; end < html.length; end += 1) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') break;
    }
    if (end >= html.length) return;
    const raw = html.slice(open + 1, end);
    const nameMatch = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(raw);
    offset = end + 1;
    if (!nameMatch) continue;
    const closing = nameMatch[1] === '/';
    const tag = nameMatch[2].toLowerCase();
    if (ignored) {
      if (closing && tag === ignored) ignored = null;
      continue;
    }
    if (!closing && (tag === 'script' || tag === 'style')) { ignored = tag; continue; }
    if (!closing) visit(tag, raw, open, end + 1);
  }
};

const extractLinks = (html, { baseUrl, selectors, maxLinks = DEFAULT_MAX_LINKS } = {}) => {
  if (typeof html !== 'string' || typeof baseUrl !== 'string' ||
      !Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > HARD_MAX_LINKS) return [];
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return [];
  } catch { return []; }
  const selected = normalizeSelectors(selectors);
  if (!selected) return [];
  const selectedSet = new Set(selected);
  const output = [];
  const seen = new Set();
  scanTags(html, (tag, raw) => {
    if (output.length >= maxLinks) return;
    const definition = SELECTOR_MAP[tag];
    if (!definition || !selectedSet.has(definition.selector)) return;
    const rawUrl = parseAttribute(raw, definition.attribute);
    if (rawUrl === null || !rawUrl.trim()) return;
    const url = normalizeExtractedUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    output.push(Object.freeze({ url, kind: tag === 'a' ? 'anchor' : tag }));
  });
  return output;
};

module.exports = {
  DEFAULT_MAX_LINKS,
  HARD_MAX_LINKS,
  SELECTORS,
  decodeEntities,
  extractLinks,
  normalizeSelectors,
  parseAttribute,
  scanTags,
};
