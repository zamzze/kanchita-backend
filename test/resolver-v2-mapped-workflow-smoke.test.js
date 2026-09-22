'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  createMappedWorkflowSmoke,
  formatMappedWorkflowSmoke,
  parseMappedWorkflowSmokeArgs,
  safeMediaLocation,
} = require('../src/modules/streams/resolverV2/diagnostics/mappedWorkflowSmoke');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const videoId = '12345678-abcd-4abc-8abc-123456789abc';
const runner = () => createMappedWorkflowSmoke({
  httpClient: createSafeHttpClient({ allowPrivateNetworks: true }), timeoutMs: 2_000,
});

test('CLI requires one safe base URL and explicit PeerTube video ID', () => {
  assert.deepEqual(parseMappedWorkflowSmokeArgs([]), { ok: false, json: false });
  assert.equal(parseMappedWorkflowSmokeArgs(['--base-url', 'https://peertube.example.test',
    '--video-id', videoId]).ok, true);
  assert.equal(parseMappedWorkflowSmokeArgs(['--base-url', 'file:///tmp/video',
    '--video-id', videoId]).ok, false);
  assert.equal(parseMappedWorkflowSmokeArgs(['--base-url', 'https://user:secret@example.test',
    '--video-id', videoId]).ok, false);
  assert.equal(parseMappedWorkflowSmokeArgs(['--base-url', 'https://example.test',
    '--video-id', 'bad id']).ok, false);
});

test('real components map one exact API item into a validated HLS stream', async () => {
  const requests = [];
  let server;
  server = await listen((request, response) => {
    requests.push(request.url);
    if (request.url === `/api/v1/videos/${videoId}`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ streamingPlaylists: [{
        playlistUrl: `${origin(server)}/static/master.m3u8?signature=secret-value`,
      }] }));
      return;
    }
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8\n');
  });
  try {
    const result = await runner().run({ baseUrl: origin(server), videoId });
    assert.equal(result.status, 'RESOLUTION_READY');
    assert.equal(result.mappingResolved, true);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.protocol, 'hls');
    assert.equal(result.validated, true);
    assert.equal(result.quality, 'auto');
    assert.equal(result.apiRequestCount, 1);
    assert.equal(result.hlsRequestCount, 1);
    assert.deepEqual(requests, [`/api/v1/videos/${videoId}`,
      '/static/master.m3u8?signature=secret-value']);
    assert.equal(result.mediaLocation,
      `127.0.0.1/static/master.m3u8`);
    assert.doesNotMatch(JSON.stringify(result), /secret-value|signature=/);
  } finally { await close(server); }
});

test('public item without a streaming playlist reports NO_PUBLIC_HLS', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"streamingPlaylists":[]}');
  });
  try {
    const result = await runner().run({ baseUrl: origin(server), videoId });
    assert.equal(result.status, 'NO_PUBLIC_HLS');
    assert.equal(result.requestCount, 1);
    assert.equal(result.hlsRequestCount, 0);
  } finally { await close(server); }
});

test('not found and non-public exact items retain explicit statuses', async () => {
  for (const [statusCode, expected] of [[404, 'VIDEO_NOT_FOUND'], [401, 'VIDEO_NOT_PUBLIC'],
    [403, 'VIDEO_NOT_PUBLIC']]) {
    const server = await listen((_request, response) => {
      response.statusCode = statusCode;
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
    try {
      const result = await runner().run({ baseUrl: origin(server), videoId });
      assert.equal(result.status, expected);
      assert.equal(result.requestCount, 1);
    } finally { await close(server); }
  }
});

test('operational HLS failures become safe engine outcomes without URL leakage', async () => {
  let server;
  server = await listen((request, response) => {
    if (request.url.startsWith('/api/v1/videos/')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ streamingPlaylists: [{
        playlistUrl: `${origin(server)}/missing.m3u8?token=private-token`,
      }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  try {
    const result = await runner().run({ baseUrl: origin(server), videoId });
    assert.equal(result.status, 'RESOLUTION_EMPTY');
    assert.equal(result.validated, false);
    assert.doesNotMatch(formatMappedWorkflowSmoke(result), /private-token|token=/);
  } finally { await close(server); }
});

test('transport failure is distinguished from an empty HLS response', async () => {
  const server = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ streamingPlaylists: [{
      playlistUrl: 'http://127.0.0.1:1/unreachable.m3u8?token=private-token',
    }] }));
  });
  try {
    const result = await runner().run({ baseUrl: origin(server), videoId });
    assert.equal(result.status, 'RESOLUTION_FAILED');
    assert.equal(result.errorCode, 'HTTP_CONNECTION_ERROR');
    assert.doesNotMatch(JSON.stringify(result), /private-token|token=/);
  } finally { await close(server); }
});

test('safe output strips query, credentials and fragments from media location', () => {
  assert.equal(safeMediaLocation('https://media.example.test/path/master.m3u8?token=x#part'),
    'media.example.test/path/master.m3u8');
  assert.equal(safeMediaLocation('not a URL'), null);
  const output = formatMappedWorkflowSmoke({ status: 'RESOLUTION_READY',
    mediaLocation: 'media.example.test/master.m3u8', validated: true });
  assert.match(output, /status=RESOLUTION_READY/);
  assert.doesNotMatch(output, /https?:\/\//);
});
