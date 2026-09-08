'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createResolverRegistry } =
  require('../src/modules/streams/resolverV2/resolverRegistry');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createResolverEngine } =
  require('../src/modules/streams/resolverV2/resolverEngine');

const master = fs.readFileSync(path.join(__dirname, 'fixtures', 'streams',
  'master-simple.m3u8'), 'utf8');
const mediaContext = {
  contentType: 'movie', contentId: 'direct-engine-fixture', tmdbId: 550,
  title: 'Direct Engine Fixture',
};
let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.local').pathname;
    if (pathname === '/master.m3u8') {
      response.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return response.end(master);
    }
    if (pathname === '/html') {
      response.setHeader('content-type', 'text/html');
      return response.end('<html>synthetic embed</html>');
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const createHarness = (legacyFallback) => {
  const direct = createDirectHlsResolver({
    httpClient: createSafeHttpClient({ allowPrivateNetworks: true, timeoutMs: 300 }),
    timeoutMs: 250,
  });
  return createResolverEngine({
    registry: createResolverRegistry([direct]), legacyFallback, timeoutMs: 500,
  });
};

test('local end-to-end path resolves HLS without legacy fallback or browser', async () => {
  let legacyCalls = 0;
  const result = await createHarness({
    resolve: async () => { legacyCalls += 1; return []; },
  }).resolve({
    mediaContext,
    candidates: [{ providerId: 'local_fixture', url: `${baseUrl}/master.m3u8` }],
  });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].protocol, 'hls');
  assert.equal(result.streams[0].providerId, 'local_fixture');
  assert.equal(result.streams[0].resolverId, 'direct_hls');
  assert.equal(result.streams[0].validated, true);
  assert.equal(result.streams[0].hlsInfo.isMaster, true);
  assert.equal(result.usedLegacyFallback, false);
  assert.equal(legacyCalls, 0);
});

test('local HTML candidate produces empty direct result and invokes fake legacy only', async () => {
  let legacyCalls = 0;
  const result = await createHarness({
    resolve: async () => { legacyCalls += 1; return []; },
  }).resolve({
    mediaContext,
    candidates: [{ providerId: 'local_fixture', url: `${baseUrl}/html` }],
  });
  assert.deepEqual(result.streams, []);
  assert.equal(result.usedLegacyFallback, true);
  assert.equal(legacyCalls, 1);
  assert.deepEqual(result.attempts.map(({ resolverId, outcome }) => ({ resolverId, outcome })), [
    { resolverId: 'direct_hls', outcome: 'empty' },
    { resolverId: 'legacy_browser', outcome: 'empty' },
  ]);
});
