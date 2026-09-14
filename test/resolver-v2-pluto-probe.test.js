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
  assert.equal(parseArgs(['--discover']).ok, true);
  assert.equal(parseArgs(['--discover', '--tmdb-id', '550', '--pluto-id', 'movie123']).ok,
    false);
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
    assert.equal(result.variant_count, 1);
    assert.equal(result.audio_count, 1);
    assert.equal(result.subtitle_count, 1);
    for (const output of [formatText(result), formatJson(result)]) {
      assert.doesNotMatch(output,
        /PRIVATE|sessionToken|Bearer|127\.0\.0\.1|master\.m3u8/i);
    }
  } finally { await close(server); }
});

test('Pluto discovery inspects one bounded catalog page then reuses the real provider path',
  async () => {
    let bootCount = 0;
    let catalogCount = 0;
    const catalogUrls = [];
    const server = await listen((request, response) => {
      if (request.url.startsWith('/boot')) {
        bootCount += 1;
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ sessionToken: jwt }));
      }
      if (request.url.startsWith('/v3/vod/categories')) {
        catalogCount += 1;
        catalogUrls.push(request.url);
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ categories: [{ items: [
          { _id: 'empty001', type: 'movie', stitched: { urls: [] } },
          { _id: 'public002', type: 'movie', stitched: { urls: [
            { url: `${origin(server)}/master.m3u8?token=PRIVATE_URL_TOKEN` },
          ] } },
        ] }] }));
      }
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nmedia.m3u8\n');
    });
    try {
      const parsed = parseArgs(['--discover', '--base-url', origin(server),
        '--boot-url', `${origin(server)}/boot`, '--timeout-ms', '3000']);
      const result = await createPlutoProbe({
        httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
      }).run(parsed.value);
      assert.equal(result.status, 'ready');
      assert.equal(result.boot_ok, true);
      assert.equal(result.catalog_ok, true);
      assert.equal(result.items_checked, 2);
      assert.equal(result.public_item_found, true);
      assert.equal(result.pluto_id, 'public002');
      assert.equal(result.content_kind, 'movie');
      assert.equal(result.hls_found, true);
      assert.equal(result.hls_valid, true);
      assert.equal(result.variant_count, 1);
      assert.equal(bootCount, 2);
      assert.equal(catalogCount, 2);
      assert.match(catalogUrls[0], /[?&]offset=0(?:&|$)/);
      assert.match(catalogUrls[0], /[?&]limit=20(?:&|$)/);
      assert.match(catalogUrls[1], /[?&]offset=1000(?:&|$)/);
      assert.doesNotMatch(formatJson(result),
        /sessionToken|Bearer|PRIVATE_URL_TOKEN|master\.m3u8|127\.0\.0\.1/i);
    } finally { await close(server); }
  });

test('Pluto discovery handles empty catalogs and items without HLS', async () => {
  for (const categories of [[], [{ items: [
    { _id: 'empty001', type: 'movie', stitched: { urls: [] } },
  ] }]]) {
    const server = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/boot')) {
        return response.end(JSON.stringify({ sessionToken: jwt }));
      }
      response.end(JSON.stringify({ categories }));
    });
    try {
      const parsed = parseArgs(['--discover', '--base-url', origin(server),
        '--boot-url', `${origin(server)}/boot`, '--timeout-ms', '3000']);
      const result = await createPlutoProbe({
        httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
      }).run(parsed.value);
      assert.equal(result.status, 'no_public_item');
      assert.equal(result.boot_ok, true);
      assert.equal(result.catalog_ok, true);
      assert.equal(result.public_item_found, false);
      assert.equal(result.hls_found, false);
    } finally { await close(server); }
  }
});

test('Pluto discovery never inspects more than twenty identified items', async () => {
  const items = Array.from({ length: 21 }, (_, index) => ({
    _id: `item${String(index).padStart(3, '0')}`,
    type: 'movie',
    stitched: { urls: index === 20 ? [{ url: 'https://example.test/master.m3u8' }] : [] },
  }));
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/boot')) {
      return response.end(JSON.stringify({ sessionToken: jwt }));
    }
    response.end(JSON.stringify({ categories: [{ items }] }));
  });
  try {
    const parsed = parseArgs(['--discover', '--base-url', origin(server),
      '--boot-url', `${origin(server)}/boot`, '--timeout-ms', '3000']);
    const result = await createPlutoProbe({
      httpClient: createSafeHttpClient({ allowPrivateNetworks: true }),
    }).run(parsed.value);
    assert.equal(result.status, 'no_public_item');
    assert.equal(result.items_checked, 20);
    assert.equal(result.pluto_id, null);
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
    assert.doesNotMatch(formatJson(result), /PRIVATE|500|127\.0\.0\.1/);
  } finally { await close(server); }
});
