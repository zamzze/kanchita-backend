'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLegacyBrowserAdapter } =
  require('../src/modules/streams/resolverV2/legacyBrowserAdapter');

const mediaContext = {
  contentType: 'episode', contentId: 'episode-fixture', tmdbId: 1399,
  title: 'Fixture Episode', season: 1, episode: 2,
};
const rejectsWithCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('null legacy result maps to an empty collection', async () => {
  assert.deepEqual(await createLegacyBrowserAdapter({ executeLegacy: async () => null })
    .resolve(mediaContext), []);
});

test('legacy fields map to a safe, explicitly unvalidated StreamCandidate', async () => {
  let receivedContext;
  const adapter = createLegacyBrowserAdapter({ executeLegacy: async (context) => {
    receivedContext = context;
    return {
      url: 'https://media.example.test/episode/master.m3u8?fixture=1',
      provider: 'provider_c', serverName: 'Fixture HD', quality: '1080p',
      language: 'en-sub', expiresAt: '2030-01-01T00:00:00Z',
    };
  } });
  const [result] = await adapter.resolve(mediaContext);
  assert.deepEqual(receivedContext, mediaContext);
  assert.equal(result.protocol, 'hls');
  assert.equal(result.providerId, 'provider_c');
  assert.equal(result.resolverId, 'legacy_browser');
  assert.equal(result.quality, '1080p');
  assert.equal(result.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal(result.validated, false);
  assert.deepEqual(result.headers, {});
  assert.equal(result.audioLanguage, null);
  assert.equal(result.subtitleLanguage, null);
  assert.deepEqual(result.metadata, {
    legacyLanguage: 'en-sub', legacyServerName: 'Fixture HD',
  });
  assert.ok(result.latencyMs >= 0);
});

test('protocol is inferred without network and declared valid protocol wins', async () => {
  const resolveUrl = async (url, protocol) => (await createLegacyBrowserAdapter({
    executeLegacy: async () => ({ url, protocol }),
  }).resolve(mediaContext))[0].protocol;
  assert.equal(await resolveUrl('https://media.example.test/a.m3u8'), 'hls');
  assert.equal(await resolveUrl('https://media.example.test/a.mp4?x=1'), 'mp4');
  assert.equal(await resolveUrl('https://media.example.test/a.mpd'), 'dash');
  assert.equal(await resolveUrl('https://media.example.test/play?id=1'), 'unknown');
  assert.equal(await resolveUrl('https://media.example.test/a.m3u8', 'dash'), 'dash');
});

test('invalid legacy structures and URLs fail with a stable code', async () => {
  for (const result of [
    [], {}, { url: 'not a url' }, { url: 'ftp://media.example.test/a.m3u8' },
    { url: 'https://media.example.test/a.m3u8', provider: { id: 'bad' } },
    { url: 'https://media.example.test/a.m3u8', expiresAt: 'invalid' },
  ]) {
    await rejectsWithCode(createLegacyBrowserAdapter({ executeLegacy: async () => result })
      .resolve(mediaContext), 'LEGACY_RESOLUTION_INVALID_RESULT');
  }
});

test('pre-aborted signal prevents executeLegacy and errors remain propagable', async () => {
  let calls = 0;
  const adapter = createLegacyBrowserAdapter({ executeLegacy: async () => {
    calls += 1;
    return null;
  } });
  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(adapter.resolve(mediaContext, { signal: controller.signal }),
    'RESOLVER_ENGINE_ABORTED');
  assert.equal(calls, 0);

  const failing = createLegacyBrowserAdapter({ executeLegacy: async () => {
    throw Object.assign(new Error('fixture'), { code: 'LEGACY_EXECUTOR_FAILED' });
  } });
  await rejectsWithCode(failing.resolve(mediaContext), 'LEGACY_EXECUTOR_FAILED');
});

test('adapter forwards cooperative cancellation context without importing legacy runtime', async () => {
  const controller = new AbortController();
  let received;
  const adapter = createLegacyBrowserAdapter({ executeLegacy: async (_media, context) => {
    received = context;
    return null;
  } });
  await adapter.resolve(mediaContext, {
    signal: controller.signal, deadlineAt: Date.now() + 1000, remainingMs: () => 1000,
  });
  assert.equal(received.signal, controller.signal);
  assert.equal(typeof received.remainingMs, 'function');

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'legacyBrowserAdapter.js'), 'utf8');
  assert.doesNotMatch(source,
    /puppeteer|puppeteer-real-browser|ProviderC|providerC|resolverExecutor|browserSlots/);
  assert.doesNotMatch(source, /streamResolver|providerManager|\bpg\b|console\./);
});
