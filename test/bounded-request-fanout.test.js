'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider, normalizeWorkflow, ERROR_CODES } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');
const { loadResolverV2Catalog } =
  require('../src/modules/streams/resolverV2/catalog/catalogLoader');

const media = Object.freeze({ contentType: 'movie', contentId: 'fixture',
  tmdbId: 550, title: 'Fixture' });
const ref = Object.freeze({ mappingId: 1, providerId: 'workflow_a', region: 'global',
  contentType: 'movie', tmdbId: 550, externalId: 'item-123',
  seasonNumber: null, episodeNumber: null, providerTitle: null,
  providerSlug: null, matchMethod: 'manual', matchConfidence: 100,
  metadata: {}, lastVerifiedAt: null });
const request = Object.freeze({ type: 'request', method: 'GET',
  path: '/qualities', saveAs: 'response' });
const extract = Object.freeze({ type: 'extractMany', from: 'response', parser: 'json',
  path: 'qualities', fields: { quality: 'quality' }, saveAs: 'qualities', maxItems: 32 });
const each = Object.freeze({ type: 'requestEach', from: 'qualities',
  request: { method: 'POST', path: '/step2',
    form: { quality: '{item.quality}', external_id: '{externalId}' } },
  extract: { parser: 'json', path: 'links',
    fields: { url: 'url', language: 'language' } }, saveAs: 'links' });
const emit = Object.freeze({ type: 'emitEach', from: 'links', url: '{item.url}',
  languageHint: '{item.language}' });
const flow = (fanout = each, tail = [emit]) => [request, extract, fanout, ...tail];
const link = (name) => ({ url: `https://media.example.test/${name}.m3u8`, language: 'es-419' });
const response = (data, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { 'content-type': contentType }, body: Buffer.from(JSON.stringify(data)),
});
const makeHarness = (qualities, options = {}) => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const http = options.http || { request: async (method, url, requestOptions) => {
    const path = new URL(url).pathname;
    const body = requestOptions.body ? Object.fromEntries(new URLSearchParams(requestOptions.body))
      : null;
    calls.push({ method, path, body, timeoutMs: requestOptions.timeoutMs });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await Promise.resolve();
      if (path === '/qualities') return response({ qualities });
      return options.onStep2?.(body, calls) ?? response({ links: [link(body.quality)] });
    } finally { active -= 1; }
  } };
  const provider = createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
    baseUrl: options.baseUrl || 'https://source.example.test',
    workflow: options.workflow || flow(), maxSteps: 8,
    maxCandidates: options.maxCandidates || 8, http,
    now: options.now || Date.now, timeoutMs: options.timeoutMs || 3000 });
  return { calls, get maxActive() { return maxActive; },
    getSources: () => provider.getSources(media, { providerMediaRef: ref }) };
};

test('requestEach normalizes immutably and revalidates with bounded defaults', () => {
  const input = flow();
  const original = structuredClone(input);
  const normalized = normalizeWorkflow(input, 8);
  assert.ok(normalized);
  assert.equal(normalized[2].type, 'requestEach');
  assert.equal(normalized[2].maxFanout, 4);
  assert.equal(normalized[2].maxItemsPerResponse, 8);
  assert.equal(Object.isFrozen(normalized[2].request.form), true);
  assert.equal(Object.isFrozen(normalized[2].extract.fields), true);
  assert.deepEqual(normalizeWorkflow(normalized, 8), normalized);
  assert.deepEqual(input, original);
});

test('one item makes one sequential POST and preserves scalar workflow variables', async () => {
  const harness = makeHarness([{ quality: '720p' }]);
  const candidates = await harness.getSources();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].languageHint, 'es-419');
  assert.deepEqual(harness.calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: '/qualities', body: null },
    { method: 'POST', path: '/step2', body: { quality: '720p', external_id: 'item-123' } },
  ]);
  assert.equal(harness.maxActive, 1);
});

test('two items make two sequential requests and keep input/response ordering', async () => {
  const harness = makeHarness([{ quality: '720p' }, { quality: '1080p' }], {
    onStep2: (body) => response({ links: [link(`${body.quality}-a`),
      link(`${body.quality}-b`)] }),
  });
  const candidates = await harness.getSources();
  assert.deepEqual(candidates.map(({ url }) => url), [
    link('720p-a').url, link('720p-b').url,
    link('1080p-a').url, link('1080p-b').url,
  ]);
  assert.deepEqual(harness.calls.map(({ path }) => path),
    ['/qualities', '/step2', '/step2']);
  assert.equal(harness.maxActive, 1);
});

test('GET fanout uses the existing path and query builder without a body', async () => {
  const calls = [];
  const workflow = flow({ ...each, request: { method: 'GET',
    path: '/quality/{item.quality}', query: { external_id: '{externalId}' } } });
  const harness = makeHarness([], { workflow, http: { request: async (method, url, options) => {
    calls.push({ method, path: new URL(url).pathname,
      externalId: new URL(url).searchParams.get('external_id'), body: options.body });
    return calls.length === 1 ? response({ qualities: [{ quality: '720p' }] })
      : response({ links: [link('720p')] });
  } } });
  assert.deepEqual((await harness.getSources()).map(({ url }) => url), [link('720p').url]);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/qualities', externalId: null, body: null },
    { method: 'GET', path: '/quality/720p', externalId: 'item-123', body: null },
  ]);
});

test('default maxFanout is four and hard maximum is eight', async () => {
  const five = Array.from({ length: 5 }, (_, n) => ({ quality: String(n) }));
  const limited = makeHarness(five);
  await assert.rejects(limited.getSources(), { code: ERROR_CODES.FANOUT_LIMIT_EXCEEDED });
  assert.equal(limited.calls.length, 1);
  assert.ok(normalizeWorkflow(flow({ ...each, maxFanout: 8 }), 8));
  assert.equal(normalizeWorkflow(flow({ ...each, maxFanout: 9 }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...each, maxFanout: 0 }), 8), null);
  const seven = makeHarness(five.concat([{ quality: '5' }, { quality: '6' }]),
    { workflow: flow({ ...each, maxFanout: 8 }) });
  assert.equal((await seven.getSources()).length, 7);
  assert.equal(seven.calls.length, 8);
});

test('eight item requests exceed the shared eight-request workflow budget', async () => {
  const qualities = Array.from({ length: 8 }, (_, n) => ({ quality: String(n) }));
  const harness = makeHarness(qualities, { workflow: flow({ ...each, maxFanout: 8 }) });
  await assert.rejects(harness.getSources(),
    { code: ERROR_CODES.REQUEST_BUDGET_EXCEEDED });
  assert.equal(harness.calls.length, 8);
});

test('truncated source collection cannot silently become a partial fanout', async () => {
  const harness = makeHarness([{ quality: 'a' }, { quality: 'b' }, { quality: 'c' }], {
    workflow: [request, { ...extract, maxItems: 2 }, each, emit],
  });
  await assert.rejects(harness.getSources(),
    { code: ERROR_CODES.FANOUT_LIMIT_EXCEEDED });
  assert.equal(harness.calls.length, 1);
});

test('source must be a safe collection and item fields/workflow variables must exist', () => {
  for (const from of ['response', 'externalId', 'unknown']) {
    assert.equal(normalizeWorkflow(flow({ ...each, from }), 8), null);
  }
  assert.equal(normalizeWorkflow(flow({ ...each,
    request: { ...each.request, path: '/step2/{item.missing}' } }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...each,
    request: { ...each.request, form: { quality: '{item.quality}', x: '{missing}' } } }), 8), null);
  assert.equal(normalizeWorkflow(flow({ ...each,
    request: { ...each.request, path: '/{item.quality.extra}' } }), 8), null);
});

test('malformed source item is skipped without a request', async () => {
  const harness = makeHarness([{ quality: '' }, { quality: '1080p' }]);
  assert.deepEqual((await harness.getSources()).map(({ url }) => url),
    [link('1080p').url]);
  assert.equal(harness.calls.length, 2);
});

test('SSRF and transport errors propagate; no later item is requested', async () => {
  let calls = 0;
  const safe = createSafeHttpClient();
  const harness = makeHarness([], { baseUrl: 'http://127.0.0.1:12345',
    http: { request: async (method, url, options) => {
      calls += 1;
      if (calls === 1) return response({ qualities: [{ quality: 'a' }, { quality: 'b' }] });
      return safe.request(method, url, options);
    } } });
  await assert.rejects(harness.getSources(), { code: 'HTTP_UNSAFE_DESTINATION' });
  assert.equal(calls, 2);
  let transportCalls = 0;
  const transport = makeHarness([], { http: { request: async () => {
    transportCalls += 1;
    if (transportCalls === 1) return response({ qualities: [{ quality: 'a' },
      { quality: 'b' }] });
    throw Object.assign(new Error('redacted'), { code: 'HTTP_CONNECTION_ERROR' });
  } } });
  await assert.rejects(transport.getSources(), { code: 'HTTP_CONNECTION_ERROR' });
  assert.equal(transportCalls, 2);
});

test('404, invalid JSON and invalid content type are per-item misses', async () => {
  for (const unusable of [response({}, 404),
    { ok: true, status: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from('invalid-json') },
    response({ links: [] }, 200, 'text/html')]) {
    const harness = makeHarness([{ quality: 'a' }, { quality: 'b' }], {
      onStep2: (body) => body.quality === 'a' ? unusable : response({ links: [link('b')] }),
    });
    assert.deepEqual((await harness.getSources()).map(({ url }) => url), [link('b').url]);
    assert.equal(harness.calls.length, 3);
  }
});

test('403 and 500 are hard HTTP failures, not per-item misses', async () => {
  for (const status of [403, 500]) {
    const harness = makeHarness([{ quality: 'a' }, { quality: 'b' }], {
      onStep2: () => response({}, status),
    });
    await assert.rejects(harness.getSources(), { code: ERROR_CODES.HTTP_ERROR });
    assert.equal(harness.calls.length, 2);
  }
});

test('maxItemsPerResponse defaults to eight, hard max is 32 and aggregate is bounded',
  async () => {
    const many = Array.from({ length: 20 }, (_, n) => link(String(n)));
    assert.equal((await makeHarness([{ quality: 'a' }], {
      onStep2: () => response({ links: many }),
    }).getSources()).length, 8);
    assert.ok(normalizeWorkflow(flow({ ...each, maxItemsPerResponse: 32 }), 8));
    assert.equal(normalizeWorkflow(flow({ ...each, maxItemsPerResponse: 33 }), 8), null);
    const overflow = makeHarness([{ quality: 'a' }, { quality: 'b' }], {
      workflow: flow({ ...each, maxItemsPerResponse: 32 }),
      onStep2: () => response({ links: many }),
    });
    await assert.rejects(overflow.getSources(),
      { code: ERROR_CODES.COLLECTION_LIMIT_EXCEEDED });
    assert.equal(overflow.calls.length, 3);
  });

test('global maxCandidates caps emitted streams after bounded fanout', async () => {
  const harness = makeHarness([{ quality: 'a' }], {
    maxCandidates: 2,
    onStep2: () => response({ links: [link('one'), link('two'), link('three')] }),
  });
  assert.deepEqual((await harness.getSources()).map(({ url }) => url),
    [link('one').url, link('two').url]);
  assert.equal(harness.calls.length, 2);
});

test('fanout result is provenance-safe for emitEach, filterMany and bindOne', async () => {
  const workflow = flow(each, [
    { type: 'filterMany', from: 'links', field: 'language', equals: 'es-419',
      saveAs: 'selected', maxItems: 1 },
    { type: 'bindOne', from: 'selected', fields: { selectedUrl: 'url' } },
    { type: 'emit', url: '{selectedUrl}' },
    emit,
  ]);
  assert.ok(normalizeWorkflow(workflow, 8));
  const harness = makeHarness([{ quality: '720p' }], { workflow });
  const result = await harness.getSources();
  assert.deepEqual(result.map(({ url }) => url), [link('720p').url, link('720p').url]);
});

test('second or nested requestEach is rejected even after filterMany', () => {
  const second = { ...each, from: 'links', saveAs: 'moreLinks' };
  assert.equal(normalizeWorkflow([request, extract, each, second], 8), null);
  assert.equal(normalizeWorkflow([request, extract, each,
    { type: 'filterMany', from: 'links', field: 'language', equals: 'es-419',
      saveAs: 'filtered' }, { ...second, from: 'filtered' }], 8), null);
});

test('existing request and extractMany still normalize unchanged', () => {
  const plain = [request, extract, { type: 'emitEach', from: 'qualities',
    url: 'https://media.example.test/{item.quality}.m3u8' }];
  assert.ok(normalizeWorkflow(plain, 8));
});

test('single workflow deadline decreases across fanout requests', async () => {
  let clock = 0;
  const harness = makeHarness([{ quality: 'a' }, { quality: 'b' }], {
    now: () => clock,
    onStep2: () => { clock += 100; return response({ links: [link('ready')] }); },
  });
  await harness.getSources();
  assert.deepEqual(harness.calls.map(({ timeoutMs }) => timeoutMs),
    [3000, 3000, 2900]);
});

test('catalog accepts the declarative requestEach without another schema', () => {
  const catalog = loadResolverV2Catalog({ enabled: true, filePath: 'fixture.json',
    readFile: () => JSON.stringify({ version: 1, sources: [{ id: 'workflow_a',
      type: 'mapped_http_workflow', enabled: true, region: 'global',
      baseUrl: 'https://source.example.test', workflow: flow() }] }), env: {} });
  assert.deepEqual(catalog.sources[0].workflow.map(({ type }) => type),
    ['request', 'extractMany', 'requestEach', 'emitEach']);
});
