'use strict';

const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  ERROR_CODES,
  HARD_MAX_CANDIDATES,
  HARD_MAX_STEPS,
  createHttpWorkflowSourceProvider,
} = require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const mediaContext = Object.freeze({ contentType: 'movie', tmdbId: 550 });
const providerMediaRef = (overrides = {}) => Object.freeze({
  providerId: 'workflow_a', region: 'latam', contentType: 'movie', tmdbId: 550,
  externalId: 'external-123', seasonNumber: null, episodeNumber: null,
  metadata: Object.freeze({}), ...overrides,
});
const make = (baseUrl, workflow, options = {}) => createHttpWorkflowSourceProvider({
  id: 'workflow_a', enabled: true, baseUrl, workflow,
  http: createSafeHttpClient({ allowPrivateNetworks: true }), ...options,
});

test('GET HTML extraction emits a normalized immutable candidate', async () => {
  let requests = 0;
  const server = await listen((request, response) => {
    requests += 1;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<div data-player-id="https://media.example.test/master.m3u8"></div>');
  });
  const workflow = [
    { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: '[data-player-id]',
      attribute: 'data-player-id', saveAs: 'embedUrl' },
    { type: 'emit', url: '{embedUrl}', languageHint: 'es-419', qualityHint: '1080p',
      metadata: { sourceType: 'workflow_fixture', nested: { fixture: true } } },
  ];
  try {
    const input = { providerMediaRef: providerMediaRef() };
    const before = structuredClone(input);
    const candidates = await make(origin(server), workflow).getSources(mediaContext, input);
    assert.equal(requests, 1);
    assert.deepEqual(input, before);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'workflow_a');
    assert.equal(candidates[0].url, 'https://media.example.test/master.m3u8');
    assert.equal(candidates[0].languageHint, 'es-419');
    assert.equal(candidates[0].qualityHint, '1080p');
    assert.equal(Object.isFrozen(candidates), true);
    assert.equal(Object.isFrozen(candidates[0]), true);
    assert.equal(Object.isFrozen(candidates[0].headers), true);
    assert.equal(Object.isFrozen(candidates[0].metadata), true);
    assert.equal(Object.isFrozen(candidates[0].metadata.nested), true);
  } finally { await close(server); }
});

test('GET extract variable then POST form and iframe extraction are sequential', async () => {
  const calls = [];
  const server = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: request.method, url: request.url, body,
        contentType: request.headers['content-type'] });
      response.setHeader('content-type', 'text/html');
      if (request.method === 'GET') return response.end('<span data-player-id="player-7"></span>');
      assert.equal(body, 'id=player-7');
      response.end('<iframe src="/embed/master.m3u8"></iframe>');
    });
  });
  const workflow = [
    { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: '[data-player-id]',
      attribute: 'data-player-id', saveAs: 'playerId' },
    { type: 'request', method: 'POST', path: '/ajax/player', form: { id: '{playerId}' },
      headers: { 'x-requested-with': 'XMLHttpRequest' }, saveAs: 'playerResponse' },
    { type: 'extract', from: 'playerResponse', parser: 'html', selector: 'iframe',
      attribute: 'src', saveAs: 'embedUrl' },
    { type: 'emit', url: '{embedUrl}', referer: `${origin(server)}/watch` },
  ];
  try {
    const candidates = await make(origin(server), workflow).getSources(mediaContext,
      { providerMediaRef: providerMediaRef() });
    assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST']);
    assert.equal(calls[1].contentType, 'application/x-www-form-urlencoded');
    assert.equal(candidates[0].url, `${origin(server)}/embed/master.m3u8`);
    assert.equal(candidates[0].referer, `${origin(server)}/watch`);
  } finally { await close(server); }
});

test('JSON path extraction feeds emit without a general expression language', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: { player: {
      url: 'https://media.example.test/json.m3u8',
    } } }));
  });
  const workflow = [
    { type: 'request', method: 'GET', path: '/api/{externalId}', saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json', path: 'data.player.url',
      saveAs: 'streamUrl' },
    { type: 'emit', url: '{streamUrl}' },
  ];
  try {
    const result = await make(origin(server), workflow).getSources(mediaContext,
      { providerMediaRef: providerMediaRef() });
    assert.equal(result[0].url, 'https://media.example.test/json.m3u8');
  } finally { await close(server); }
});

test('JSON extraction supports only bounded dot array indexes', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      streamingPlaylists: [{ playlistUrl: 'https://media.example.test/array.m3u8' }],
      files: [{ fileUrl: 'https://media.example.test/file.mp4' }],
    }));
  });
  try {
    for (const [path, expected] of [
      ['streamingPlaylists.0.playlistUrl', 'https://media.example.test/array.m3u8'],
      ['files.0.fileUrl', 'https://media.example.test/file.mp4'],
    ]) {
      const workflow = [
        { type: 'request', method: 'GET', path: '/api', saveAs: 'payload' },
        { type: 'extract', from: 'payload', parser: 'json', path, saveAs: 'mediaUrl' },
        { type: 'emit', url: '{mediaUrl}' },
      ];
      const result = await make(origin(server), workflow).getSources(mediaContext,
        { providerMediaRef: providerMediaRef() });
      assert.equal(result[0].url, expected);
    }
  } finally { await close(server); }
});

test('JSON extraction rejects unsafe and expressive array paths', () => {
  const request = { type: 'request', method: 'GET', path: '/api', saveAs: 'payload' };
  for (const path of ['streamingPlaylists.-1.playlistUrl',
    'streamingPlaylists.*.playlistUrl', 'streamingPlaylists[0].playlistUrl',
    'streamingPlaylists.32.playlistUrl', '__proto__.url', 'constructor.url',
    'prototype.url']) {
    assert.throws(() => createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
      baseUrl: 'https://source.example.test', workflow: [request,
        { type: 'extract', from: 'payload', parser: 'json', path, saveAs: 'url' }] }),
    { code: ERROR_CODES.INVALID_WORKFLOW });
  }
});

test('HTML text extraction is bounded and can feed an emitted URL', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<span> https://media.example.test/text.m3u8 </span>');
  });
  const workflow = [
    { type: 'request', method: 'GET', path: '/text', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: 'span', text: true,
      saveAs: 'streamUrl' },
    { type: 'emit', url: '{streamUrl}' },
  ];
  try {
    const result = await make(origin(server), workflow).getSources(mediaContext,
      { providerMediaRef: providerMediaRef() });
    assert.equal(result[0].url, 'https://media.example.test/text.m3u8');
  } finally { await close(server); }
});

test('episode placeholders render into bounded query and JSON POST bodies', async () => {
  const episodeContext = Object.freeze({ contentType: 'episode', tmdbId: 77,
    season: 2, episode: 4 });
  const episodeRef = providerMediaRef({ contentType: 'episode', tmdbId: 77,
    externalId: 'episode-77', seasonNumber: 2, episodeNumber: 4 });
  const server = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, origin(server));
      assert.equal(url.pathname, '/episode/77');
      assert.equal(url.searchParams.get('season'), '2');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),
        { external: 'episode-77', episode: '4' });
      response.setHeader('content-type', 'application/json');
      response.end('{"data":{"url":"https://media.example.test/episode.m3u8"}}');
    });
  });
  const workflow = [
    { type: 'request', method: 'POST', path: '/episode/{tmdbId}',
      query: { season: '{season}' }, json: { external: '{externalId}', episode: '{episode}' },
      saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json', path: 'data.url', saveAs: 'url' },
    { type: 'emit', url: '{url}' },
  ];
  try {
    const result = await make(origin(server), workflow).getSources(episodeContext,
      { providerMediaRef: episodeRef });
    assert.equal(result[0].url, 'https://media.example.test/episode.m3u8');
  } finally { await close(server); }
});

test('multiple emits retain deterministic order and maxCandidates is absolute', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"url":"https://media.example.test/a.m3u8"}');
  });
  const workflow = [
    { type: 'request', method: 'GET', path: '/source', saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json', path: 'url', saveAs: 'first' },
    { type: 'emit', url: '{first}', qualityHint: '1080p' },
    { type: 'emit', url: 'https://media.example.test/b.m3u8', qualityHint: '720p' },
  ];
  try {
    const provider = make(origin(server), workflow, { maxCandidates: 1 });
    const run = () => provider.getSources(mediaContext, { providerMediaRef: providerMediaRef() });
    const first = await run();
    const second = await run();
    assert.deepEqual(first, second);
    assert.deepEqual(first.map(({ qualityHint }) => qualityHint), ['1080p']);
  } finally { await close(server); }
});

test('missing or mismatched ProviderMediaRef fails closed without network', async () => {
  let requests = 0;
  const provider = make('https://source.example.test', [
    { type: 'request', method: 'GET', path: '/item/{externalId}', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: 'iframe',
      attribute: 'src', saveAs: 'url' },
    { type: 'emit', url: '{url}' },
  ], { http: { request: async () => { requests += 1; } } });
  for (const ref of [undefined, providerMediaRef({ providerId: 'other' }),
    providerMediaRef({ externalId: '' }), providerMediaRef({ tmdbId: 999 })]) {
    assert.deepEqual(await provider.getSources(mediaContext, { providerMediaRef: ref }), []);
  }
  assert.equal(requests, 0);
});

test('missing extraction and 404 are empty while 401 and 403 are hard failures', async () => {
  const workflow = [
    { type: 'request', method: 'GET', path: '/{externalId}', saveAs: 'page' },
    { type: 'extract', from: 'page', parser: 'html', selector: 'iframe',
      attribute: 'src', saveAs: 'url' },
    { type: 'emit', url: '{url}' },
  ];
  const server = await listen((request, response) => {
    const mode = request.url.slice(1);
    if (mode === 'missing-extract') {
      response.setHeader('content-type', 'text/html');
      return response.end('<p>none</p>');
    }
    response.statusCode = Number(mode);
    response.end();
  });
  try {
    for (const externalId of ['missing-extract', '404']) {
      assert.deepEqual(await make(origin(server), workflow).getSources(mediaContext,
        { providerMediaRef: providerMediaRef({ externalId }) }), []);
    }
    for (const externalId of ['401', '403']) {
      await assert.rejects(make(origin(server), workflow).getSources(mediaContext,
        { providerMediaRef: providerMediaRef({ externalId }) }),
      { code: ERROR_CODES.HTTP_ERROR });
    }
  } finally { await close(server); }
});

test('malformed JSON is controlled and body limits remain SafeHttpClient errors', async () => {
  const workflow = [
    { type: 'request', method: 'GET', path: '/{externalId}', saveAs: 'payload' },
    { type: 'extract', from: 'payload', parser: 'json', path: 'data.url', saveAs: 'url' },
    { type: 'emit', url: '{url}' },
  ];
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(request.url.includes('large') ? JSON.stringify({ data: { url: 'x'.repeat(512) } })
      : '{bad');
  });
  try {
    await assert.rejects(make(origin(server), workflow).getSources(mediaContext,
      { providerMediaRef: providerMediaRef({ externalId: 'badjson' }) }),
    { code: ERROR_CODES.INVALID_JSON });
    await assert.rejects(make(origin(server), workflow, { maxBytes: 64 }).getSources(mediaContext,
      { providerMediaRef: providerMediaRef({ externalId: 'large' }) }),
    { code: 'HTTP_RESPONSE_TOO_LARGE' });
  } finally { await close(server); }
});

test('timeout and AbortSignal propagate without retries', async () => {
  let requests = 0;
  const server = await listen((_request, response) => {
    requests += 1;
    setTimeout(() => { response.setHeader('content-type', 'text/html'); response.end('<p>x</p>'); },
      250);
  });
  const workflow = [{ type: 'request', method: 'GET', path: '/slow', saveAs: 'page' }];
  try {
    await assert.rejects(make(origin(server), workflow, { timeoutMs: 100 })
      .getSources(mediaContext, { providerMediaRef: providerMediaRef() }),
    { code: 'HTTP_TIMEOUT' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(make(origin(server), workflow)
      .getSources(mediaContext, { providerMediaRef: providerMediaRef(),
        signal: controller.signal }), { code: 'HTTP_ABORTED' });
    assert.equal(requests, 1);
  } finally { await close(server); }
});

test('workflow, bounds, headers and credential-bearing base URLs fail construction', () => {
  const request = { type: 'request', method: 'GET', path: '/item', saveAs: 'page' };
  const config = { id: 'workflow_a', enabled: true, baseUrl: 'https://source.example.test',
    workflow: [request] };
  for (const maxSteps of [0, HARD_MAX_STEPS + 1, 1.5, Infinity]) {
    assert.throws(() => createHttpWorkflowSourceProvider({ ...config, maxSteps }),
      { code: ERROR_CODES.INVALID_CONFIG });
  }
  for (const maxCandidates of [0, HARD_MAX_CANDIDATES + 1, 1.5, Infinity]) {
    assert.throws(() => createHttpWorkflowSourceProvider({ ...config, maxCandidates }),
      { code: ERROR_CODES.INVALID_CONFIG });
  }
  assert.throws(() => createHttpWorkflowSourceProvider({ ...config,
    workflow: Array.from({ length: 6 }, (_, index) => ({ ...request, saveAs: `page${index}` })) }),
  { code: ERROR_CODES.INVALID_WORKFLOW });
  for (const name of ['cookie', 'authorization', 'proxy-authorization', 'set-cookie']) {
    assert.throws(() => createHttpWorkflowSourceProvider({ ...config,
      workflow: [{ ...request, headers: { [name]: 'secret' } }] }),
    { code: ERROR_CODES.INVALID_WORKFLOW });
  }
  assert.throws(() => createHttpWorkflowSourceProvider({ ...config,
    baseUrl: 'https://user:secret@source.example.test' }),
  { code: ERROR_CODES.INVALID_CONFIG });
  assert.throws(() => createHttpWorkflowSourceProvider({ ...config,
    workflow: [{ ...request, path: '/{missingVariable}' }] }),
  { code: ERROR_CODES.INVALID_WORKFLOW });
});

test('SSRF remains delegated to SafeHttpClient and private targets are denied by default',
  async () => {
    const server = await listen((_request, response) => response.end('unexpected'));
    try {
      const provider = createHttpWorkflowSourceProvider({ id: 'workflow_a', enabled: true,
        baseUrl: origin(server), http: createSafeHttpClient(),
        workflow: [{ type: 'request', method: 'GET', path: '/item', saveAs: 'page' }] });
      await assert.rejects(provider.getSources(mediaContext,
        { providerMediaRef: providerMediaRef() }), { code: 'HTTP_UNSAFE_DESTINATION' });
    } finally { await close(server); }
  });

test('provider is isolated from browser, execution, global DB and direct network clients', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|\bbrowser\b|child_process|\beval\s*\(|new Function|\bfetch\s*\(|http\.get|https\.get|axios|config\/db|ProviderC|ResolverExecutor/i);
});
