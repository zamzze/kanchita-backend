'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://http:http@127.0.0.1:5432/http';
process.env.JWT_SECRET ||= 'http-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'http-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'http-test-tmdb-key';
delete process.env.ALLOW_PUBLIC_REGISTRATION;

const appModule = require('../../src/app');
const { createApp } = appModule;
const pool = require('../../src/config/db');
const errorHandler = require('../../src/middleware/errorHandler');
const { createDefaultLimiter } = require('../../src/middleware/rateLimiter');
const {
  isExplicitlyEnabled,
  parseCorsOrigins,
} = require('../../src/config/env');
const { redactSensitive } = require('../../src/utils/redact');

const ALLOWED_ORIGIN = 'https://pwa.example.test';
const subtitlesDir = path.join(__dirname, '../fixtures/subtitles');

const buildApp = (overrides = {}) => createApp({
  corsOrigins: [ALLOWED_ORIGIN],
  allowPublicRegistration: false,
  subtitlesDir,
  ...overrides,
});

after(async () => {
  await pool.end();
});

test('serves existing VTT files publicly without authentication', async () => {
  const response = await request(buildApp()).get('/subtitles/sample.vtt');

  assert.equal(response.status, 200);
  assert.match(response.text, /^WEBVTT/);
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
});

test('keeps login public', async () => {
  const response = await request(buildApp())
    .post('/api/auth/login')
    .send({});

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'BAD_REQUEST');
});

test('disables public registration by default', async () => {
  const response = await request(createApp({ corsOrigins: [ALLOWED_ORIGIN], subtitlesDir }))
    .post('/api/auth/register')
    .send({ email: 'person@example.test', password: 'valid-password' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'REGISTRATION_DISABLED');
});

test('enables registration only for the exact true flag', async () => {
  assert.equal(isExplicitlyEnabled('true'), true);
  assert.equal(isExplicitlyEnabled('TRUE'), false);
  assert.equal(isExplicitlyEnabled('1'), false);
  assert.equal(isExplicitlyEnabled(undefined), false);

  const response = await request(buildApp({
    allowPublicRegistration: isExplicitlyEnabled('true'),
  }))
    .post('/api/auth/register')
    .send({});

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'BAD_REQUEST');
});

test('requires authentication for subtitle resolution API', async () => {
  const response = await request(buildApp())
    .get('/api/subtitles/123?type=movie&id=00000000-0000-0000-0000-000000000001');

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
});

test('allows a configured CORS origin', async () => {
  const secondOrigin = 'https://tv.example.test';
  const response = await request(buildApp({
    corsOrigins: parseCorsOrigins(`${ALLOWED_ORIGIN}, ${secondOrigin}/`),
  }))
    .get('/subtitles/sample.vtt')
    .set('Origin', secondOrigin);

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], secondOrigin);
});

test('rejects an unconfigured CORS origin predictably', async () => {
  const response = await request(buildApp())
    .get('/subtitles/sample.vtt')
    .set('Origin', 'https://untrusted.example.test');

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'CORS_ORIGIN_DENIED');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('answers allowed CORS preflight requests', async () => {
  const response = await request(buildApp())
    .options('/api/auth/login')
    .set('Origin', ALLOWED_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('applies the general rate limiter before API routes', async () => {
  const app = buildApp({
    apiLimiter: createDefaultLimiter({ windowMs: 60_000, max: 2 }),
  });

  assert.equal((await request(app).get('/api/missing')).status, 404);
  assert.equal((await request(app).get('/api/missing')).status, 404);

  const limited = await request(app).get('/api/missing');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
});

test('does not expose internal error details in HTTP 500 responses', async () => {
  const app = express();
  const internalMessage = [
    'SELECT password_hash FROM users',
    'C:\\private\\database.sql',
    'postgresql://admin:real-password@database.internal:5432/app',
    'https://cdn.example.test/private.m3u8?token=temporary-token',
  ].join(' ');
  app.get('/failure', () => {
    throw new Error(internalMessage);
  });
  app.use(errorHandler);

  const originalConsoleError = console.error;
  let logged = '';
  console.error = (...args) => {
    logged = args.join(' ');
  };

  try {
    const response = await request(app).get('/failure');
    const body = JSON.stringify(response.body);

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'INTERNAL_ERROR');
    assert.equal(response.body.message, 'Internal server error');
    assert.doesNotMatch(body, /SELECT|password_hash|private|real-password|m3u8|temporary-token/);
    assert.doesNotMatch(body, /stack/i);
    assert.doesNotMatch(logged, /real-password|temporary-token|private\.m3u8/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('exposes only the allowlisted stream-unavailable 503 contract', async () => {
  const app = express();
  app.get('/stream', (req, res, next) => {
    const failure = new Error('Stream temporarily unavailable');
    failure.statusCode = 503;
    failure.code = 'STREAM_TEMPORARILY_UNAVAILABLE';
    failure.safeToExpose = true;
    next(failure);
  });
  app.use(errorHandler);

  const response = await request(app).get('/stream');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'STREAM_TEMPORARILY_UNAVAILABLE');
  assert.equal(response.body.message, 'Stream temporarily unavailable');
});

test('redacts common secret-bearing log values', () => {
  const value = redactSensitive(
    'Bearer access-token postgresql://admin:password@db/app ' +
    'https://api.example.test/path?api_key=secret-value ' +
    'https://cdn.example.test/video.m3u8?token=signed-value'
  );

  assert.doesNotMatch(value, /access-token|admin:password|secret-value|signed-value/);
  assert.match(value, /\[REDACTED\]/);
});

test('preserves legitimate 401, 403 and 404 status codes', async (t) => {
  const app = buildApp();

  await t.test('401', async () => {
    const response = await request(app).get('/api/movies');
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'UNAUTHORIZED');
  });

  await t.test('403', async () => {
    const response = await request(app).post('/api/auth/register').send({});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'REGISTRATION_DISABLED');
  });

  await t.test('404', async () => {
    const response = await request(app).get('/missing');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'NOT_FOUND');
  });
});
