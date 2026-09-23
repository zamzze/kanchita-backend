'use strict';

const { normalizeEmbedCandidate } = require('../resolverContracts');
const { normalizeBaseUrl } = require('./configuredHttpSourceProvider');

const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'SOURCE_WORKFLOW_INVALID_CONFIG',
  INVALID_WORKFLOW: 'SOURCE_WORKFLOW_INVALID_WORKFLOW',
  REQUEST_FAILED: 'SOURCE_WORKFLOW_REQUEST_FAILED',
  HTTP_ERROR: 'SOURCE_WORKFLOW_HTTP_ERROR',
  INVALID_CONTENT_TYPE: 'SOURCE_WORKFLOW_INVALID_CONTENT_TYPE',
  INVALID_JSON: 'SOURCE_WORKFLOW_INVALID_JSON',
  CAPTURE_TOO_LARGE: 'SOURCE_WORKFLOW_CAPTURE_TOO_LARGE',
});
const DEFAULT_MAX_STEPS = 5;
const HARD_MAX_STEPS = 8;
const DEFAULT_MAX_CANDIDATES = 8;
const HARD_MAX_CANDIDATES = 32;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_TEMPLATE_LENGTH = 4096;
const MAX_VARIABLE_LENGTH = 4096;
const MAX_TEXT_DELIMITER_LENGTH = 256;
const MAX_TEXT_CAPTURE_LENGTH = MAX_VARIABLE_LENGTH;
const MAX_OBJECT_ENTRIES = 32;
const DEFAULT_MAX_ITEMS = 8;
const HARD_MAX_ITEMS = 32;
const MAX_COLLECTION_FIELDS = 16;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ITEMS = 128;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SIMPLE_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ARRAY_INDEX_SEGMENT = /^(?:0|[1-9]\d?)$/;
const MAX_ARRAY_INDEX = 31;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9_:-]{0,63}$/;
const TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const HTML_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const TEXT_CONTENT_TYPE = /^(?:text\/[a-z0-9!#$&^_.+-]+|application\/(?:[a-z0-9!#$&^_.+-]+\+json|json|xhtml\+xml|javascript|xml))(?:\s*;|$)/i;
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent',
  'x-requested-with',
]);
const PLAYBACK_HEADER_ALLOWLIST = new Set([
  'accept', 'accept-language', 'origin', 'range', 'referer', 'user-agent',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const providerError = (code) => Object.assign(new Error(code), { code });

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneJsonLike = (value, state = { depth: 0, items: 0, seen: new Set() }) => {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || state.depth > MAX_METADATA_DEPTH) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value) && !isPlainObject(value) || state.seen.has(value)) return undefined;
  state.seen.add(value);
  const next = { depth: state.depth + 1, items: state.items, seen: state.seen };
  const output = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(value) && (!key || key.length > 128 || FORBIDDEN_KEYS.has(key))) {
      state.seen.delete(value);
      return undefined;
    }
    const cloned = cloneJsonLike(item, next);
    if (cloned === undefined) {
      state.seen.delete(value);
      return undefined;
    }
    output[key] = cloned;
  }
  state.items = next.items;
  state.seen.delete(value);
  return output;
};

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const normalizeTemplate = (value) => {
  if (typeof value !== 'string' || !value || value.length > MAX_TEMPLATE_LENGTH) return null;
  const withoutPlaceholders = value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, '');
  return /[{}]/.test(withoutPlaceholders) ? null : value;
};

const normalizeItemTemplate = (value) => {
  if (typeof value !== 'string' || value.length > MAX_TEMPLATE_LENGTH) return null;
  const scalarTemplate = value.replace(/\{item\.([A-Za-z][A-Za-z0-9_]*)\}/g, '{$1}');
  if (!normalizeTemplate(scalarTemplate) ||
      /\{([A-Za-z][A-Za-z0-9_]*)\}/.test(value)) return null;
  return value;
};

const renderItemTemplate = (template, item) => renderTemplate(
  template.replace(/\{item\.([A-Za-z][A-Za-z0-9_]*)\}/g, '{$1}'), item);

const templateNames = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
  .map((match) => match[1]);

const renderTemplate = (template, variables) => {
  let valid = true;
  const output = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const value = variables[name];
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      valid = false;
      return '';
    }
    const normalized = String(value);
    if (!normalized || normalized.length > MAX_VARIABLE_LENGTH) valid = false;
    return normalized;
  });
  return valid && output.length <= MAX_TEMPLATE_LENGTH * 2 ? output : null;
};

const normalizeTemplateObject = (value, allowlist = null, normalize = normalizeTemplate) => {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value) || Object.keys(value).length > MAX_OBJECT_ENTRIES) return null;
  const output = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    const template = normalize(rawValue);
    if (!ATTRIBUTE_NAME.test(name) || FORBIDDEN_KEYS.has(name) ||
        (allowlist && !allowlist.has(name)) || !template || /[\r\n]/.test(rawName + rawValue)) {
      return null;
    }
    output[name] = template;
  }
  return Object.freeze(output);
};

const normalizeJsonPath = (path) => {
  const segments = typeof path === 'string' ? path.split('.') : [];
  return segments.length >= 1 && segments.length <= 8 &&
    segments.every((segment) => !FORBIDDEN_KEYS.has(segment) &&
      (SIMPLE_PATH_SEGMENT.test(segment) ||
        ARRAY_INDEX_SEGMENT.test(segment) && Number(segment) <= MAX_ARRAY_INDEX))
    ? path : null;
};

const normalizeSelector = (value) => {
  if (isPlainObject(value) &&
      Object.keys(value).every((key) => ['tag', 'requiredAttribute'].includes(key)) &&
      (value.tag === null || typeof value.tag === 'string' && TAG_NAME.test(value.tag)) &&
      (value.requiredAttribute === null || typeof value.requiredAttribute === 'string' &&
        ATTRIBUTE_NAME.test(value.requiredAttribute)) &&
      (value.tag !== null || value.requiredAttribute !== null)) {
    return Object.freeze({ tag: value.tag, requiredAttribute: value.requiredAttribute });
  }
  if (typeof value !== 'string' || value.length > 128) return null;
  const normalized = value.trim().toLowerCase();
  let match = /^([a-z][a-z0-9-]{0,31})$/.exec(normalized);
  if (match) return Object.freeze({ tag: match[1], requiredAttribute: null });
  match = /^\[([a-z][a-z0-9_:-]{0,63})\]$/.exec(normalized);
  if (match) return Object.freeze({ tag: null, requiredAttribute: match[1] });
  match = /^([a-z][a-z0-9-]{0,31})\[([a-z][a-z0-9_:-]{0,63})\]$/.exec(normalized);
  return match ? Object.freeze({ tag: match[1], requiredAttribute: match[2] }) : null;
};

const normalizeRequestStep = (step) => {
  const allowed = new Set(['type', 'method', 'path', 'query', 'headers', 'form', 'json', 'saveAs']);
  if (!isPlainObject(step) || Object.keys(step).some((key) => !allowed.has(key)) ||
      !['GET', 'POST'].includes(step.method) || !VARIABLE_NAME.test(step.saveAs)) return null;
  const path = normalizeTemplate(step.path);
  const query = normalizeTemplateObject(step.query);
  const headers = normalizeTemplateObject(step.headers, REQUEST_HEADER_ALLOWLIST);
  const form = normalizeTemplateObject(step.form);
  const json = normalizeTemplateObject(step.json);
  if (!path || !query || !headers || !form || !json ||
      Object.keys(form).length && Object.keys(json).length ||
      step.method === 'GET' && (Object.keys(form).length || Object.keys(json).length)) return null;
  return Object.freeze({ type: 'request', method: step.method, path, query, headers,
    form, json, saveAs: step.saveAs });
};

const normalizeExtractStep = (step) => {
  if (!isPlainObject(step) || !VARIABLE_NAME.test(step.from) ||
      !VARIABLE_NAME.test(step.saveAs) || !['html', 'json', 'text'].includes(step.parser)) {
    return null;
  }
  if (step.parser === 'json') {
    const allowed = new Set(['type', 'from', 'parser', 'path', 'saveAs']);
    if (Object.keys(step).some((key) => !allowed.has(key)) ||
        !normalizeJsonPath(step.path)) return null;
    return Object.freeze({ type: 'extract', from: step.from, parser: 'json',
      path: step.path, saveAs: step.saveAs });
  }
  if (step.parser === 'text') {
    const allowed = new Set(['type', 'from', 'parser', 'start', 'end', 'saveAs']);
    const validDelimiter = (value) => typeof value === 'string' && value.length >= 1 &&
      value.length <= MAX_TEXT_DELIMITER_LENGTH && !/[{}]/.test(value);
    if (Object.keys(step).some((key) => !allowed.has(key)) ||
        !validDelimiter(step.start) || !validDelimiter(step.end)) return null;
    return Object.freeze({ type: 'extract', from: step.from, parser: 'text',
      start: step.start, end: step.end, saveAs: step.saveAs });
  }
  const allowed = new Set(['type', 'from', 'parser', 'selector', 'attribute', 'text', 'saveAs']);
  const selector = normalizeSelector(step.selector);
  const attribute = step.attribute === undefined ? null
    : typeof step.attribute === 'string' && ATTRIBUTE_NAME.test(step.attribute.toLowerCase())
      ? step.attribute.toLowerCase() : null;
  const useText = step.text === true;
  if (Object.keys(step).some((key) => !allowed.has(key)) || !selector ||
      Boolean(attribute) === useText) return null;
  return Object.freeze({ type: 'extract', from: step.from, parser: 'html', selector,
    attribute, text: useText, saveAs: step.saveAs });
};

const normalizeExtractManyStep = (step) => {
  const allowed = new Set(['type', 'from', 'parser', 'path', 'fields', 'saveAs', 'maxItems']);
  if (!isPlainObject(step) || Object.keys(step).some((key) => !allowed.has(key)) ||
      !VARIABLE_NAME.test(step.from) || !VARIABLE_NAME.test(step.saveAs) ||
      step.parser !== 'json' ||
      (step.path !== '$' && !normalizeJsonPath(step.path)) ||
      !isPlainObject(step.fields)) return null;
  const entries = Object.entries(step.fields);
  if (entries.length < 1 || entries.length > MAX_COLLECTION_FIELDS ||
      entries.some(([name, path]) => !VARIABLE_NAME.test(name) ||
        FORBIDDEN_KEYS.has(name) || !normalizeJsonPath(path))) return null;
  const maxItems = step.maxItems === undefined ? DEFAULT_MAX_ITEMS : step.maxItems;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > HARD_MAX_ITEMS) return null;
  return Object.freeze({ type: 'extractMany', from: step.from, parser: 'json',
    path: step.path, fields: Object.freeze(Object.fromEntries(entries)),
    saveAs: step.saveAs, maxItems });
};

const normalizeFilterManyStep = (step) => {
  const allowed = new Set(['type', 'from', 'field', 'equals', 'saveAs', 'maxItems']);
  if (!isPlainObject(step) || Object.keys(step).some((key) => !allowed.has(key)) ||
      !VARIABLE_NAME.test(step.from) || !VARIABLE_NAME.test(step.saveAs) ||
      !VARIABLE_NAME.test(step.field) || FORBIDDEN_KEYS.has(step.field)) return null;
  const equals = normalizeTemplate(step.equals);
  const maxItems = step.maxItems === undefined ? DEFAULT_MAX_ITEMS : step.maxItems;
  if (!equals || !Number.isInteger(maxItems) || maxItems < 1 ||
      maxItems > HARD_MAX_ITEMS) return null;
  return Object.freeze({ type: 'filterMany', from: step.from, field: step.field,
    equals, saveAs: step.saveAs, maxItems });
};

const normalizeEmitStep = (step, each = false) => {
  const allowed = new Set(['type', ...(each ? ['from'] : []), 'url', 'referer', 'origin', 'headers',
    'languageHint', 'qualityHint', 'metadata']);
  if (!isPlainObject(step) || Object.keys(step).some((key) => !allowed.has(key))) return null;
  if (each && !VARIABLE_NAME.test(step.from)) return null;
  const normalize = each ? normalizeItemTemplate : normalizeTemplate;
  const url = normalize(step.url);
  const referer = step.referer == null ? null : normalize(step.referer);
  const origin = step.origin == null ? null : normalize(step.origin);
  const languageHint = step.languageHint == null ? null
    : normalize(step.languageHint);
  const qualityHint = step.qualityHint == null ? null : normalize(step.qualityHint);
  const headers = normalizeTemplateObject(step.headers, PLAYBACK_HEADER_ALLOWLIST, normalize);
  const metadata = step.metadata == null ? null : cloneJsonLike(step.metadata);
  if (!url || step.referer != null && !referer || step.origin != null && !origin ||
      step.languageHint != null && !languageHint ||
      step.qualityHint != null && !qualityHint || !headers ||
      step.metadata != null && (!isPlainObject(step.metadata) || metadata === undefined)) {
    return null;
  }
  return Object.freeze({ type: each ? 'emitEach' : 'emit', ...(each ? { from: step.from } : {}),
    url, referer, origin, languageHint, qualityHint,
    headers, metadata: metadata === null ? null : deepFreeze(metadata) });
};

const normalizeWorkflow = (workflow, maxSteps) => {
  if (!Array.isArray(workflow) || workflow.length < 1 || workflow.length > maxSteps) return null;
  const output = [];
  const available = new Set(['externalId', 'tmdbId', 'season', 'episode',
    'contentType', 'region']);
  const responses = new Set();
  const collections = new Map();
  const assigned = new Set(available);
  for (const rawStep of workflow) {
    const type = typeof rawStep?.type === 'string' ? rawStep.type.toLowerCase() : '';
    const step = type === 'request' ? normalizeRequestStep({ ...rawStep, type,
      method: typeof rawStep.method === 'string' ? rawStep.method.toUpperCase() : rawStep.method })
      : type === 'extract' ? normalizeExtractStep({ ...rawStep, type })
        : type === 'extractmany' ? normalizeExtractManyStep({ ...rawStep, type })
          : type === 'filtermany' ? normalizeFilterManyStep({ ...rawStep, type })
            : type === 'emit' ? normalizeEmitStep({ ...rawStep, type })
              : type === 'emiteach' ? normalizeEmitStep({ ...rawStep, type }, true) : null;
    if (!step) return null;
    const templates = step.type === 'request'
      ? [step.path, ...Object.values(step.query), ...Object.values(step.headers),
        ...Object.values(step.form), ...Object.values(step.json)]
      : step.type === 'emit'
        ? [step.url, step.referer, step.origin, step.languageHint, step.qualityHint,
          ...Object.values(step.headers)].filter(Boolean)
        : step.type === 'filterMany' ? [step.equals] : [];
    if (templates.some((template) => templateNames(template)
      .some((name) => !available.has(name)))) return null;
    if (step.type === 'request') {
      if (assigned.has(step.saveAs)) return null;
      responses.add(step.saveAs);
      assigned.add(step.saveAs);
    }
    if (step.type === 'extract' || step.type === 'extractMany') {
      if (!responses.has(step.from) || assigned.has(step.saveAs)) return null;
      if (step.type === 'extract') available.add(step.saveAs);
      else collections.set(step.saveAs, new Set(Object.keys(step.fields)));
      assigned.add(step.saveAs);
    }
    if (step.type === 'filterMany') {
      const fields = collections.get(step.from);
      if (!fields || !fields.has(step.field) || assigned.has(step.saveAs)) return null;
      collections.set(step.saveAs, fields);
      assigned.add(step.saveAs);
    }
    if (step.type === 'emitEach' && !collections.has(step.from)) return null;
    output.push(step);
  }
  return Object.freeze(output);
};

const renderObject = (templates, variables) => {
  const output = {};
  for (const [name, template] of Object.entries(templates)) {
    const value = renderTemplate(template, variables);
    if (value === null) return null;
    output[name] = value;
  }
  return output;
};

const parseAttributes = (raw) => {
  const attributes = {};
  const source = raw.replace(/^\s*[^\s/>]+/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!FORBIDDEN_KEYS.has(name)) attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
};

const decodeEntities = (value) => value.replace(/&(?:amp|quot|apos|lt|gt|#39);/gi,
  (entity) => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<',
    '&gt;': '>', '&#39;': "'" })[entity.toLowerCase()] || entity);

const extractHtml = (html, definition, baseUrl) => {
  let offset = 0;
  while (offset < html.length) {
    const open = html.indexOf('<', offset);
    if (open < 0) return null;
    const end = html.indexOf('>', open + 1);
    if (end < 0) return null;
    const raw = html.slice(open + 1, end);
    offset = end + 1;
    const nameMatch = /^\s*([a-z][a-z0-9-]*)/i.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    const attributes = parseAttributes(raw);
    if (definition.selector.tag && definition.selector.tag !== tag ||
        definition.selector.requiredAttribute &&
          !Object.hasOwn(attributes, definition.selector.requiredAttribute)) continue;
    if (definition.attribute) {
      if (!Object.hasOwn(attributes, definition.attribute)) return null;
      const value = decodeEntities(attributes[definition.attribute].trim());
      if (!value) return null;
      if (definition.attribute === 'src' || definition.attribute === 'href') {
        try {
          const url = new URL(value, baseUrl);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            ? url.toString() : null;
        } catch { return null; }
      }
      return value.length <= MAX_VARIABLE_LENGTH ? value : null;
    }
    const close = html.toLowerCase().indexOf(`</${tag}`, offset);
    if (close < 0) return null;
    const value = decodeEntities(html.slice(offset, close).replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ').trim());
    return value && value.length <= MAX_VARIABLE_LENGTH ? value : null;
  }
  return null;
};

const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) &&
  String(value).length <= MAX_VARIABLE_LENGTH ? value : null;

const lookupJsonPath = (payload, path) => {
  let current = payload;
  for (const segment of path.split('.')) {
    if (FORBIDDEN_KEYS.has(segment)) return null;
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_SEGMENT.test(segment) || Number(segment) > MAX_ARRAY_INDEX ||
          !Object.hasOwn(current, Number(segment))) return null;
      current = current[Number(segment)];
    } else {
      if (!isPlainObject(current) || !SIMPLE_PATH_SEGMENT.test(segment) ||
          !Object.hasOwn(current, segment)) return null;
      current = current[segment];
    }
  }
  return current;
};

const extractJson = (payload, path) => scalar(lookupJsonPath(payload, path));

const extractMany = (payload, step) => {
  const source = step.path === '$' ? payload : lookupJsonPath(payload, step.path);
  if (!Array.isArray(source)) return null;
  const items = [];
  for (const sourceItem of source.slice(0, step.maxItems)) {
    if (!isPlainObject(sourceItem)) continue;
    const item = Object.create(null);
    let valid = true;
    for (const [name, path] of Object.entries(step.fields)) {
      const value = extractJson(sourceItem, path);
      if (value === null) { valid = false; break; }
      item[name] = value;
    }
    if (valid) items.push(Object.freeze(item));
  }
  return Object.freeze(items);
};

const filterMany = (source, step, variables) => {
  const expected = renderTemplate(step.equals, variables);
  if (expected === null) return Object.freeze([]);
  const selected = [];
  for (const item of source) {
    if (selected.length >= step.maxItems) break;
    const value = item[step.field];
    // Only canonical scalar representations compare; no loose equality or title matching.
    if (typeof value === 'string' && value === expected ||
        typeof value === 'number' && Number.isSafeInteger(value) &&
          String(value) === expected) selected.push(item);
  }
  return Object.freeze(selected);
};

const extractText = (source, start, end) => {
  if (typeof source !== 'string') return null;
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return null;
  const valueStart = startIndex + start.length;
  const endIndex = source.indexOf(end, valueStart);
  if (endIndex < 0 || endIndex === valueStart) return null;
  const value = source.slice(valueStart, endIndex);
  if (value.length > MAX_TEXT_CAPTURE_LENGTH) throw providerError(ERROR_CODES.CAPTURE_TOO_LARGE);
  return value;
};

const immutableCandidate = (candidate) => {
  return deepFreeze(candidate);
};

const buildCandidate = (step, variables, id, render = renderTemplate) => {
  const url = render(step.url, variables);
  const headers = {};
  for (const [name, template] of Object.entries(step.headers)) {
    const value = render(template, variables);
    if (value === null) return null;
    headers[name] = value;
  }
  const referer = step.referer ? render(step.referer, variables) : null;
  const origin = step.origin ? render(step.origin, variables) : null;
  const languageHint = step.languageHint ? render(step.languageHint, variables) : null;
  const qualityHint = step.qualityHint ? render(step.qualityHint, variables) : null;
  if (!url || step.referer && !referer || step.origin && !origin ||
      step.languageHint && !languageHint || step.qualityHint && !qualityHint) return null;
  const candidate = normalizeEmbedCandidate({ providerId: id, url, referer, origin, headers,
    languageHint, qualityHint, metadata: step.metadata });
  return candidate ? immutableCandidate(candidate) : null;
};

const createHttpWorkflowSourceProvider = ({
  id = 'http_workflow', enabled = false, priority = 100, baseUrl = '', workflow = [], http,
  timeoutMs = 3_000, maxBytes = DEFAULT_MAX_BYTES, maxRedirects = 3,
  maxCandidates = DEFAULT_MAX_CANDIDATES, maxSteps = DEFAULT_MAX_STEPS,
  supportsMovies = true, supportsEpisodes = true, now = Date.now,
} = {}) => {
  const base = normalizeBaseUrl(baseUrl);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      typeof enabled !== 'boolean' || !Number.isInteger(priority) || !base ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 ||
      maxCandidates > HARD_MAX_CANDIDATES || !Number.isInteger(maxSteps) || maxSteps < 1 ||
      maxSteps > HARD_MAX_STEPS || typeof supportsMovies !== 'boolean' ||
      typeof supportsEpisodes !== 'boolean' || typeof now !== 'function') {
    throw providerError(ERROR_CODES.INVALID_CONFIG);
  }
  const steps = normalizeWorkflow(workflow, maxSteps);
  if (!steps) throw providerError(ERROR_CODES.INVALID_WORKFLOW);
  const active = enabled === true;

  const getSources = async (mediaContext, runtime = {}) => {
    if (!active) return [];
    const ref = runtime.providerMediaRef;
    if (!isPlainObject(ref) || ref.providerId !== id || ref.contentType !== mediaContext?.contentType ||
        ref.tmdbId !== mediaContext?.tmdbId || typeof ref.region !== 'string' ||
        typeof ref.externalId !== 'string' || !ref.externalId.trim() ||
        ref.externalId.length > MAX_VARIABLE_LENGTH ||
        (ref.contentType === 'movie' &&
          (ref.seasonNumber !== null || ref.episodeNumber !== null)) ||
        (ref.contentType === 'episode' &&
          (!Number.isInteger(ref.seasonNumber) || ref.seasonNumber < 0 ||
            !Number.isInteger(ref.episodeNumber) || ref.episodeNumber < 1 ||
            ref.seasonNumber !== mediaContext.season ||
            ref.episodeNumber !== mediaContext.episode))) return [];
    const client = runtime.http || http;
    if (!client || typeof client.request !== 'function') {
      throw providerError(ERROR_CODES.INVALID_CONFIG);
    }
    const variables = Object.assign(Object.create(null), {
      externalId: ref.externalId.trim(), tmdbId: ref.tmdbId,
      season: ref.seasonNumber, episode: ref.episodeNumber,
      contentType: ref.contentType, region: ref.region,
    });
    const responses = Object.create(null);
    const collections = Object.create(null);
    const candidates = [];
    const deadlineAt = Math.min(now() + timeoutMs,
      Number.isFinite(runtime.deadlineAt) ? runtime.deadlineAt : Infinity);
    for (const step of steps) {
      if (step.type === 'request') {
        const remainingMs = Math.floor(deadlineAt - now());
        if (remainingMs < 1) throw Object.assign(new Error('HTTP_TIMEOUT'), { code: 'HTTP_TIMEOUT' });
        const renderedPath = renderTemplate(step.path, variables);
        const query = renderObject(step.query, variables);
        const headers = renderObject(step.headers, variables);
        const form = renderObject(step.form, variables);
        const json = renderObject(step.json, variables);
        if (renderedPath === null || !query || !headers || !form || !json) return [];
        let url;
        try {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(renderedPath)) return [];
          url = new URL(renderedPath, base);
          if (url.username || url.password || url.origin !== base.origin) return [];
          for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
        } catch { return []; }
        let body = null;
        if (Object.keys(form).length) {
          body = new URLSearchParams(form).toString();
          headers['content-type'] = 'application/x-www-form-urlencoded';
        } else if (Object.keys(json).length) {
          body = JSON.stringify(json);
          headers['content-type'] = 'application/json';
        }
        let response;
        try {
          response = await client.request(step.method, url.toString(), {
            headers, body, timeoutMs: remainingMs, maxBytes, maxRedirects,
            signal: runtime.signal,
          });
        } catch (error) {
          if (typeof error?.code === 'string' && error.code.startsWith('HTTP_')) throw error;
          throw providerError(ERROR_CODES.REQUEST_FAILED);
        }
        if (response.status === 404) return [];
        if (!response.ok) throw providerError(ERROR_CODES.HTTP_ERROR);
        responses[step.saveAs] = response;
        continue;
      }
      if (step.type === 'extract' || step.type === 'extractMany') {
        const response = responses[step.from];
        if (!response) return [];
        const contentType = response.headers?.['content-type'];
        let value = null;
        if (step.parser === 'html') {
          if (typeof contentType !== 'string' || !HTML_CONTENT_TYPE.test(contentType.trim())) {
            throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
          }
          value = extractHtml(response.body.toString('utf8'), step, response.url);
        } else if (step.parser === 'json') {
          if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
            throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
          }
          let payload;
          if (step.type === 'extractMany' &&
              (!Buffer.isBuffer(response.body) || response.body.length > maxBytes)) {
            throw providerError(ERROR_CODES.CAPTURE_TOO_LARGE);
          }
          try { payload = JSON.parse(response.body.toString('utf8')); } catch {
            throw providerError(ERROR_CODES.INVALID_JSON);
          }
          value = step.type === 'extractMany' ? extractMany(payload, step)
            : extractJson(payload, step.path);
        } else {
          if (typeof contentType !== 'string' || !TEXT_CONTENT_TYPE.test(contentType.trim())) {
            throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
          }
          const body = Buffer.isBuffer(response.body) ? response.body.toString('utf8')
            : typeof response.body === 'string' ? response.body : null;
          value = extractText(body, step.start, step.end);
        }
        if (value === null) return [];
        if (step.type === 'extractMany') collections[step.saveAs] = value;
        else variables[step.saveAs] = value;
        continue;
      }
      if (step.type === 'filterMany') {
        const source = collections[step.from];
        if (!Array.isArray(source)) return [];
        collections[step.saveAs] = filterMany(source, step, variables);
        continue;
      }
      if (step.type === 'emitEach') {
        const items = collections[step.from];
        if (!Array.isArray(items)) return [];
        for (const item of items) {
          if (candidates.length >= maxCandidates) break;
          const candidate = buildCandidate(step, item, id, renderItemTemplate);
          if (candidate) candidates.push(candidate);
        }
        if (candidates.length >= maxCandidates) return Object.freeze(candidates);
        continue;
      }
      if (candidates.length >= maxCandidates) continue;
      const candidate = buildCandidate(step, variables, id);
      if (!candidate) return [];
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) return Object.freeze(candidates);
    }
    return Object.freeze(candidates);
  };

  return Object.freeze({
    descriptor: Object.freeze({ id, active, priority, supportsMovies, supportsEpisodes,
      languages: Object.freeze([]), strategy: 'http', timeoutMs, maxCandidates }),
    getSources,
  });
};

module.exports = {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_STEPS,
  ERROR_CODES,
  HARD_MAX_CANDIDATES,
  HARD_MAX_STEPS,
  MAX_TEXT_CAPTURE_LENGTH,
  MAX_TEXT_DELIMITER_LENGTH,
  createHttpWorkflowSourceProvider,
  extractText,
  normalizeWorkflow,
  renderTemplate,
};
