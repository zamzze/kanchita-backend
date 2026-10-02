'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } =
  require('../src/modules/streams/http/safeHttpClient');
const { createHttpWorkflowSourceProvider } =
  require('../src/modules/streams/resolverV2/providers/httpWorkflowSourceProvider');

const media = Object.freeze({
  contentType: 'movie',
  contentId: 'fixture-movie',
  tmdbId: 550,
  title: 'Fixture',
});

const ref = Object.freeze({
  providerId: 'workflow_fixture',
  region: 'global',
  contentType: 'movie',
  tmdbId: 550,
  externalId: 'movie-1',
  seasonNumber: null,
  episodeNumber: null,
});

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

test('workflow core handles GET text capture, JSON collection and emitEach', async (t) => {
  const server = await listen((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/watch/movie-1') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script>{"sources":' + JSON.stringify([
        { file: `${base}/hls/a.m3u8` },
        { file: `${base}/hls/b.m3u8` },
      ]) + ',"other":null}</script>');
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const provider = createHttpWorkflowSourceProvider({
    id: 'workflow_fixture',
    enabled: true,
    baseUrl,
    maxSteps: 8,
    http: client,
    workflow: [
      { type: 'request', method: 'GET', path: '/watch/{externalId}', saveAs: 'page' },
      { type: 'extract', from: 'page', parser: 'text',
        start: '"sources":', end: ',"other":', saveAs: 'captured' },
      { type: 'parseJsonMany', from: 'captured', path: '$',
        fields: { url: 'file' }, saveAs: 'items' },
      { type: 'emitEach', from: 'items', url: '{item.url}' },
    ],
  });

  const candidates = await provider.getSources(media, { providerMediaRef: ref });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => item.url), [
    `${baseUrl}/hls/a.m3u8`,
    `${baseUrl}/hls/b.m3u8`,
  ]);
});

test('workflow core handles same-origin POST form and scalar JSON extraction', async (t) => {
  let posted = null;
  const server = await listen((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/api/resolve' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        posted = Object.fromEntries(new URLSearchParams(body));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ url: `${base}/hls/resolved.m3u8` }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createSafeHttpClient({ allowPrivateNetworks: true });
  const provider = createHttpWorkflowSourceProvider({
    id: 'workflow_fixture',
    enabled: true,
    baseUrl,
    maxSteps: 8,
    http: client,
    workflow: [
      { type: 'request', method: 'POST', path: '/api/resolve',
        form: { id: '{externalId}' }, saveAs: 'response' },
      { type: 'extract', from: 'response', parser: 'json',
        path: 'url', saveAs: 'mediaUrl' },
      { type: 'emit', url: '{mediaUrl}' },
    ],
  });

  const candidates = await provider.getSources(media, { providerMediaRef: ref });
  assert.deepEqual(posted, { id: 'movie-1' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, `${baseUrl}/hls/resolved.m3u8`);
});
