'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://test.invalid/test';
process.env.JWT_SECRET ||= 'unused-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'unused-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'unused-test-tmdb-key';

const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const {
  createPlutoProbe,
  formatJson,
  formatText,
  parseArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/plutoProbeCli');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const jwt = 'header.' + Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url') + '.sig';

test('Pluto probe CLI requires explicit mapping and emits sanitized summaries', async () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--tmdb-id', '550', '--pluto-id', 'movie123']).ok, true);
  assert.equal(parseArgs(['--content-type', 'episode', '--tmdb-id', '10',
    '--pluto-id', 'episode123', '--season', '1', '--episode', '2']).ok, true);
  assert.equal(parseArgs(['--url', 'https://example.test']).ok, false);

  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt }));
    }
    if (request.url.startsWith('/v3/vod/categories')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ categories: [{ items: [
        { _id: 'movie123', name: 'PRIVATE TITLE', stitched: { urls: [
          { url: `${origin(server)}/master.m3u8?token=PRIVATE_URL_TOKEN` },
        ] } },
      ] }] }));
    }
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    response.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="es-419",NAME="Latino"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",LANGUAGE="es",NAME="ES",URI="sub.vtt"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a",SUBTITLES="s"\nmedia.m3u8\n');
  });
  try {
    const parsed = parseArgs(['--tmdb-id', '550', '--pluto-id', 'movie123',
      '--base-url', origin(server), '--boot-url', `${origin(server)}/boot`,
      '--timeout-ms', '3000']);
    const result = await createPlutoProbe({
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    }).run(parsed.value);
    assert.equal(result.status, 'ready');
    assert.equal(result.boot_ok, true);
    assert.equal(result.catalog_ok, true);
    assert.equal(result.hls_found, true);
    assert.equal(result.hls_valid, true);
    assert.equal(result.variants, 1);
    assert.deepEqual(result.audio, ['es-419']);
    assert.deepEqual(result.subtitles, ['es']);
    for (const output of [formatText(result), formatJson(result)]) {
      assert.doesNotMatch(output,
        /PRIVATE|movie123|sessionToken|Bearer|127\.0\.0\.1|master\.m3u8/i);
    }
  } finally { await close(server); }
});

test('Pluto probe maps operational failures to coarse statuses only', async () => {
  const server = await listen((request, response) => {
    if (request.url.startsWith('/boot')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ sessionToken: jwt }));
    }
    response.statusCode = 500;
    response.end('PRIVATE BODY');
  });
  try {
    const result = await createPlutoProbe({
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    }).run({
      contentType: 'movie',
      tmdbId: 550,
      plutoId: 'movie123',
      baseUrl: origin(server),
      bootUrl: `${origin(server)}/boot`,
      timeoutMs: 3000,
    });
    assert.equal(result.status, 'unreachable');
    assert.doesNotMatch(formatJson(result), /PRIVATE|500|movie123|127\.0\.0\.1/);
  } finally { await close(server); }
});
