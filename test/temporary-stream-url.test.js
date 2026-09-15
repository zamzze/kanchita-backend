'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://test.invalid/test';
process.env.JWT_SECRET ||= 'temporary-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'temporary-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'temporary-test-tmdb';

const {
  TEMPORARY_URL_SAFETY_WINDOW_MS,
  describeUrlSafely,
  isTemporaryUrlReusable,
  parseJwtExpiry,
  temporaryExpiryFromUrl,
} = require('../src/modules/streams/temporaryStreamUrl');
const { normalizeEmbedCandidate, normalizeStreamCandidate } =
  require('../src/modules/streams/resolverV2/resolverContracts');
const { createDirectHlsResolver } =
  require('../src/modules/streams/resolverV2/resolvers/directHlsResolver');
const { createPrimaryAcceptanceGate, PRIMARY_CODES } =
  require('../src/modules/streams/resolverV2/primaryAcceptanceGate');
const { createStreamLifecycle, isFreshReadyStream } =
  require('../src/modules/streams/streamLifecycle');
const { createStreamRanker } =
  require('../src/modules/streams/resolverV2/ranking/streamRanker');

const at = Date.parse('2030-01-01T00:00:00Z');
const token = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const signedUrl = (payload) => `https://media.example.test/master.m3u8?jwt=${token(payload)}&x=1`;

test('bounded JWT parsing uses only a valid integer exp and fails closed', () => {
  const expected = '2030-01-01T00:05:00.000Z';
  const exp = Math.floor(Date.parse(expected) / 1000);
  assert.equal(parseJwtExpiry(token({ exp, role: 'ignored' })), expected);
  for (const value of [null, '', 'one.two', 'a.@@@.c', token({}), token({ exp: '1' }),
    token({ exp: -1 }), `a.${'a'.repeat(6000)}.c`]) assert.equal(parseJwtExpiry(value), null);
  assert.equal(temporaryExpiryFromUrl(signedUrl({ exp })), expected);
  assert.equal(temporaryExpiryFromUrl('https://example.test/a.m3u8?jwt=malformed'), null);
});

test('temporary URL reuse is strictly outside the shared safety window', () => {
  const stream = (offset) => ({ urlSensitivity: 'temporary_signed',
    expiresAt: new Date(at + offset).toISOString() });
  assert.equal(isTemporaryUrlReusable(stream(TEMPORARY_URL_SAFETY_WINDOW_MS + 1),
    { now: at }), true);
  assert.equal(isTemporaryUrlReusable(stream(TEMPORARY_URL_SAFETY_WINDOW_MS),
    { now: at }), false);
  assert.equal(isTemporaryUrlReusable(stream(1), { now: at }), false);
  assert.equal(isTemporaryUrlReusable({ urlSensitivity: 'temporary_signed' },
    { now: at }), false);
  assert.equal(isTemporaryUrlReusable({ urlSensitivity: 'normal' }, { now: at }), true);
});

test('URL diagnostics expose structure but never query values', () => {
  const secret = 'SIGNED_FIXTURE_SECRET';
  const summary = describeUrlSafely(`https://media.example.test/path/master.m3u8?jwt=${secret}`,
    { sensitive: true });
  assert.deepEqual(summary, { scheme: 'https', host: 'media.example.test',
    path: '/path/master.m3u8', hasQuery: true, sensitive: true });
  assert.doesNotMatch(JSON.stringify(summary), /SIGNED_FIXTURE_SECRET|jwt=/);
});

test('candidate contracts and DirectHlsResolver preserve sensitivity and expiry', async () => {
  const expiresAt = new Date(at + 300_000).toISOString();
  const embed = normalizeEmbedCandidate({ providerId: 'pluto_fixture',
    url: signedUrl({ exp: Math.floor((at + 300_000) / 1000) }), headers: {},
    expiresAt, urlSensitivity: 'temporary_signed' });
  const httpClient = {
    head: async () => { throw new Error('m3u8 must use GET fast path'); },
    get: async (url) => ({ ok: true, status: 200, url, headers: {},
      body: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n') }),
  };
  const [stream] = await createDirectHlsResolver({ httpClient }).resolve(embed);
  assert.equal(stream.expiresAt, expiresAt);
  assert.equal(stream.urlSensitivity, 'temporary_signed');
  assert.equal(stream.validated, true);
});

test('Primary requires known healthy expiry for temporary signed streams', () => {
  const gate = createPrimaryAcceptanceGate({ now: () => at });
  const candidate = (expiresAt) => normalizeStreamCandidate({
    url: signedUrl({ exp: Math.floor((at + 300_000) / 1000) }), protocol: 'hls',
    providerId: 'pluto_fixture', resolverId: 'direct_hls', headers: {}, validated: true,
    expiresAt, urlSensitivity: 'temporary_signed',
    metadata: { resolverStrategy: 'direct' },
  });
  assert.equal(gate.evaluate(candidate(null)).code, PRIMARY_CODES.TEMPORARY_EXPIRY_REQUIRED);
  assert.equal(gate.evaluate(candidate(new Date(at - 1).toISOString())).code,
    PRIMARY_CODES.EXPIRED);
  assert.equal(gate.evaluate(candidate(new Date(at + 59_999).toISOString())).code,
    PRIMARY_CODES.EXPIRING_TOO_SOON);
  assert.equal(gate.evaluate(candidate(new Date(at + 60_001).toISOString())).code,
    PRIMARY_CODES.ACCEPTED);
});

test('ranking drops unusable temporary URLs before Primary selection', () => {
  const make = (overrides) => normalizeStreamCandidate({
    url: 'https://media.example.test/master.m3u8', protocol: 'hls',
    providerId: 'fixture', resolverId: 'direct_hls', headers: {}, validated: true,
    metadata: { resolverStrategy: 'direct' }, ...overrides,
  });
  const normal = make({ audioLanguage: 'en', urlSensitivity: 'normal' });
  const nearLatino = make({ audioLanguage: 'es-419', urlSensitivity: 'temporary_signed',
    expiresAt: new Date(at + 30_000).toISOString() });
  const healthyLatino = make({ audioLanguage: 'es-419', urlSensitivity: 'temporary_signed',
    expiresAt: new Date(at + 300_000).toISOString() });
  const ranker = createStreamRanker({ now: () => at });
  assert.deepEqual(ranker.rank([nearLatino, normal]), [normal]);
  assert.equal(ranker.selectBest([normal, healthyLatino]).selected.urlSensitivity,
    'temporary_signed');
});

test('lifecycle cache reuses healthy signed URLs and refuses near-expiry URLs', () => {
  const base = { status: 'ready', stream_url: 'https://media.example.test/a.m3u8?jwt=secret',
    url_sensitivity: 'temporary_signed', last_verified_at: new Date(at).toISOString() };
  assert.equal(isFreshReadyStream({ ...base,
    expires_at: new Date(at + 60_001).toISOString() }, 10_000, at), true);
  assert.equal(isFreshReadyStream({ ...base,
    expires_at: new Date(at + 60_000).toISOString() }, 10_000, at), false);
});

test('near-expiry cache is cleared without leaking its signed query to logs or SQL params',
  async () => {
    const secret = 'NEVER_LOG_OR_COPY_TOKEN';
    const row = { id: 'stream-id', status: 'ready',
      stream_url: `https://media.example.test/a.m3u8?jwt=${secret}`,
      url_sensitivity: 'temporary_signed', expires_at: new Date(Date.now() + 10_000),
      last_verified_at: new Date(), playback_headers: null };
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT/.test(sql)) return { rows: [row] };
      return { rows: [] };
    } };
    const messages = [];
    const lifecycle = createStreamLifecycle({ db, validator: async () => {
      throw new Error('near-expiry stream must not reach validation');
    }, logger: { log: (message) => messages.push(message),
      warn: (message) => messages.push(message) }, cacheTtlMinutes: 60,
    verifyIntervalMinutes: 10, temporaryUrlSafetySeconds: 60 });
    const result = await lifecycle.readUsableCache('movie', 'content-id', { validate: true });
    assert.equal(result.streams, null);
    const stale = calls.find(({ sql }) => /UPDATE streams/.test(sql));
    assert.match(stale.sql, /temporary_signed.*THEN NULL/s);
    assert.deepEqual(stale.params, ['stream-id']);
    assert.doesNotMatch(messages.join('\n') + JSON.stringify(stale.params),
      /NEVER_LOG_OR_COPY_TOKEN|jwt=/);
  });
