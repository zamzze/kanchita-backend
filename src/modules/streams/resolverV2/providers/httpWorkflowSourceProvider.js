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
});
const DEFAULT_MAX_STEPS = 5;
const HARD_MAX_STEPS = 8;
const DEFAULT_MAX_CANDIDATES = 8;
const HARD_MAX_CANDIDATES = 32;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_TEMPLATE_LENGTH = 4096;
const MAX_VARIABLE_LENGTH = 4096;
const MAX_OBJECT_ENTRIES = 32;
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

const normalizeTemplateObject = (value, allowlist = null) => {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value) || Object.keys(value).length > MAX_OBJECT_ENTRIES) return null;
  const output = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    const template = normalizeTemplate(rawValue);
    if (!ATTRIBUTE_NAME.test(name) || FORBIDDEN_KEYS.has(name) ||
        (allowlist && !allowlist.has(name)) || !template || /[\r\n]/.test(rawName + rawValue)) {
      return null;
    }
    output[name] = template;
  }
  return Object.freeze(output);
};

const normalizeSelector = (value) => {
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
      !VARIABLE_NAME.test(step.saveAs) || !['html', 'json'].includes(step.parser)) return null;
  if (step.parser === 'json') {
    const allowed = new Set(['type', 'from', 'parser', 'path', 'saveAs']);
    const segments = typeof step.path === 'string' ? step.path.split('.') : [];
    if (Object.keys(step).some((key) => !allowed.has(key)) || segments.length < 1 ||
        segments.length > 8 || segments.some((segment) => FORBIDDEN_KEYS.has(segment) ||
          !SIMPLE_PATH_SEGMENT.test(segment) &&
          (!ARRAY_INDEX_SEGMENT.test(segment) || Number(segment) > MAX_ARRAY_INDEX))) return null;
    return Object.freeze({ type: 'extract', from: step.from, parser: 'json',
      path: step.path, saveAs: step.saveAs });
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

const normalizeEmitStep = (step) => {
  const allowed = new Set(['type', 'url', 'referer', 'origin', 'headers',
    'languageHint', 'qualityHint', 'metadata']);
  if (!isPlainObject(step) || Object.keys(step).some((key) => !allowed.has(key))) return null;
  const url = normalizeTemplate(step.url);
  const referer = step.referer === undefined ? null : normalizeTemplate(step.referer);
  const origin = step.origin === undefined ? null : normalizeTemplate(step.origin);
  const languageHint = step.languageHint === undefined ? null
    : normalizeTemplate(step.languageHint);
  const qualityHint = step.qualityHint === undefined ? null : normalizeTemplate(step.qualityHint);
  const headers = normalizeTemplateObject(step.headers, PLAYBACK_HEADER_ALLOWLIST);
  const metadata = step.metadata === undefined ? null : cloneJsonLike(step.metadata);
  if (!url || step.referer !== undefined && !referer || step.origin !== undefined && !origin ||
      step.languageHint !== undefined && !languageHint ||
      step.qualityHint !== undefined && !qualityHint || !headers ||
      step.metadata !== undefined && (!isPlainObject(step.metadata) || metadata === undefined)) {
    return null;
  }
  return Object.freeze({ type: 'emit', url, referer, origin, languageHint, qualityHint,
    headers, metadata: metadata === null ? null : deepFreeze(metadata) });
};

const normalizeWorkflow = (workflow, maxSteps) => {
  if (!Array.isArray(workflow) || workflow.length < 1 || workflow.length > maxSteps) return null;
  const output = [];
  const available = new Set(['externalId', 'tmdbId', 'season', 'episode',
    'contentType', 'region']);
  const responses = new Set();
  const assigned = new Set(available);
  for (const rawStep of workflow) {
    const type = typeof rawStep?.type === 'string' ? rawStep.type.toLowerCase() : '';
    const step = type === 'request' ? normalizeRequestStep({ ...rawStep, type,
      method: typeof rawStep.method === 'string' ? rawStep.method.toUpperCase() : rawStep.method })
      : type === 'extract' ? normalizeExtractStep({ ...rawStep, type })
        : type === 'emit' ? normalizeEmitStep({ ...rawStep, type }) : null;
    if (!step) return null;
    const templates = step.type === 'request'
      ? [step.path, ...Object.values(step.query), ...Object.values(step.headers),
        ...Object.values(step.form), ...Object.values(step.json)]
      : step.type === 'emit'
        ? [step.url, step.referer, step.origin, step.languageHint, step.qualityHint,
          ...Object.values(step.headers)].filter(Boolean) : [];
    if (templates.some((template) => templateNames(template)
      .some((name) => !available.has(name)))) return null;
    if (step.type === 'request') {
      if (assigned.has(step.saveAs)) return null;
      responses.add(step.saveAs);
      assigned.add(step.saveAs);
    }
    if (step.type === 'extract') {
      if (!responses.has(step.from) || assigned.has(step.saveAs)) return null;
      available.add(step.saveAs);
      assigned.add(step.saveAs);
    }
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

const extractJson = (payload, path) => {
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
  return scalar(current);
};

const immutableCandidate = (candidate) => {
  return deepFreeze(candidate);
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
      if (step.type === 'extract') {
        const response = responses[step.from];
        if (!response) return [];
        const contentType = response.headers?.['content-type'];
        let value = null;
        if (step.parser === 'html') {
          if (typeof contentType !== 'string' || !HTML_CONTENT_TYPE.test(contentType.trim())) {
            throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
          }
          value = extractHtml(response.body.toString('utf8'), step, response.url);
        } else {
          if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
            throw providerError(ERROR_CODES.INVALID_CONTENT_TYPE);
          }
          let payload;
          try { payload = JSON.parse(response.body.toString('utf8')); } catch {
            throw providerError(ERROR_CODES.INVALID_JSON);
          }
          value = extractJson(payload, step.path);
        }
        if (value === null) return [];
        variables[step.saveAs] = value;
        continue;
      }
      if (candidates.length >= maxCandidates) continue;
      const url = renderTemplate(step.url, variables);
      const headers = renderObject(step.headers, variables);
      const referer = step.referer ? renderTemplate(step.referer, variables) : null;
      const origin = step.origin ? renderTemplate(step.origin, variables) : null;
      const languageHint = step.languageHint
        ? renderTemplate(step.languageHint, variables) : null;
      const qualityHint = step.qualityHint ? renderTemplate(step.qualityHint, variables) : null;
      if (!url || !headers || step.referer && !referer || step.origin && !origin ||
          step.languageHint && !languageHint || step.qualityHint && !qualityHint) return [];
      const candidate = normalizeEmbedCandidate({ providerId: id, url, referer, origin, headers,
        languageHint, qualityHint, metadata: step.metadata });
      if (!candidate) return [];
      candidates.push(immutableCandidate(candidate));
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
  createHttpWorkflowSourceProvider,
  normalizeWorkflow,
  renderTemplate,
};
