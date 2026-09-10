'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSafeHttpClient } = require('../src/modules/streams/http/safeHttpClient');
const { createRealNetworkProbe } =
  require('../src/modules/streams/resolverV2/diagnostics/realNetworkProbe');
const { parseNetworkProbeArgs, formatNetworkProbeJson, formatNetworkProbeText } =
  require('../src/modules/streams/resolverV2/diagnostics/networkProbeCli');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;

test('network probe CLI permits only the fixed official allowlist', () => {
  assert.deepEqual(parseNetworkProbeArgs(['--probe', 'apple']),
    { ok: true, all: false, probe: 'apple', json: false });
  assert.equal(parseNetworkProbeArgs(['--all', '--json']).ok, true);
  for (const args of [['--url', 'https://x'], ['--probe', 'other'],
    ['--all', '--probe', 'apple'], ['--token', 'x'], []]) {
    assert.equal(parseNetworkProbeArgs(args).ok, false);
  }
});

test('offline probe traverses real V2 transport, HLS inspection, ranking and gate', async () => {
  const server = await listen((request, response) => {
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    if (request.url === '/invalid.m3u8') return response.end('<html>PRIVATE BODY</html>');
    response.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="es-419",NAME="Latino"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"\nmedia.m3u8\n');
  });
  try {
    const client = createSafeHttpClient({ allowPrivateNetworks: true });
    const runner = createRealNetworkProbe({ httpClient: client, probes: [
      { id: 'apple', kind: 'hls', enabled: true, url: `${origin(server)}/master.m3u8` },
      { id: 'cloudflare', kind: 'hls', enabled: true,
        url: `${origin(server)}/invalid.m3u8` },
    ] });
    const ready = await runner.run('apple');
    assert.equal(ready.status, 'ready');
    assert.equal(ready.isMaster, true);
    assert.equal(ready.variantCount, 1);
    assert.equal(ready.audioTrackCount, 1);
    assert.equal(ready.acceptanceCode, 'PRIMARY_ACCEPTED');
    const invalid = await runner.run('cloudflare');
    assert.equal(invalid.status, 'invalid');
    assert.equal((await runner.run('unknown')).status, 'failed');
    for (const output of [formatNetworkProbeJson([ready]),
      formatNetworkProbeText([ready]), JSON.stringify(invalid)]) {
      assert.doesNotMatch(output, /127\.0\.0\.1|master\.m3u8|PRIVATE BODY|media\.m3u8/);
    }
  } finally { await close(server); }
});

test('production network policy remains active in diagnostic runner', async () => {
  const runner = createRealNetworkProbe({ httpClient: createSafeHttpClient(), probes: [
    { id: 'apple', kind: 'hls', enabled: true,
      url: 'http://127.0.0.1/private/path?token=fake-token-XYZ' },
  ] });
  const result = await runner.run('apple');
  assert.equal(result.status, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|private|fake-token/i);
});
