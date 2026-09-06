'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://auth:auth@127.0.0.1:5432/auth';
process.env.JWT_SECRET ||= 'auth-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'auth-test-refresh-secret';
process.env.JWT_ISSUER ||= 'kanchita-auth-test';
process.env.JWT_ACCESS_AUDIENCE ||= 'kanchita-auth-clients';
process.env.JWT_REFRESH_AUDIENCE ||= 'kanchita-auth-refresh';
process.env.TMDB_API_KEY ||= 'auth-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_auth_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;

const { runMigrations } = require('../../database/migrate');
const { hashPassword } = require('../../src/utils/hash');
const { hashRefreshToken } = require('../../src/utils/tokenHash');
const { createAuthService } = require('../../src/modules/auth/auth.service');
const {
  JWT_ALGORITHM,
  verifyAccessToken,
  verifyRefreshToken,
} = require('../../src/utils/jwt');
const env = require('../../src/config/env');
const errorHandler = require('../../src/middleware/errorHandler');
const configuredPool = require('../../src/config/db');

const authService = pool ? createAuthService({ pool }) : null;
let passwordHash;
let userCounter = 0;

const expectStatus = (statusCode) => (error) => error.statusCode === statusCode;

const createTestUser = async ({ active = true } = {}) => {
  userCounter += 1;
  const email = `auth-${userCounter}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_active)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email`,
    [email, passwordHash, `Auth user ${userCounter}`, active]
  );
  return { ...rows[0], password: 'correct-horse-battery-staple' };
};

const login = (user) => authService.login({
  email: user.email,
  password: user.password,
});

before(async () => {
  if (!TEST_DB_URL) return;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({ pool, logger: { log() {} } });
  passwordHash = await hashPassword('correct-horse-battery-staple');
});

after(async () => {
  await pool?.end();
  await configuredPool.end().catch(() => {});
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test(
  'auth sessions use PostgreSQL-backed rotation and revocation',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run auth integration tests' },
  async (t) => {
    await t.test('login creates a session containing only the matching token hash', async () => {
      const user = await createTestUser();
      const result = await login(user);
      const refreshPayload = verifyRefreshToken(result.refreshToken);
      const accessPayload = verifyAccessToken(result.accessToken);
      const session = await pool.query(
        `SELECT refresh_token_hash, expires_at, revoked_at
         FROM auth_sessions WHERE id = $1`,
        [refreshPayload.sid]
      );
      const legacy = await pool.query(
        'SELECT refresh_token FROM users WHERE id = $1',
        [user.id]
      );

      assert.equal(session.rowCount, 1);
      assert.equal(session.rows[0].refresh_token_hash, hashRefreshToken(result.refreshToken));
      assert.notEqual(session.rows[0].refresh_token_hash, result.refreshToken);
      assert.equal(session.rows[0].revoked_at, null);
      assert.ok(new Date(session.rows[0].expires_at) > new Date());
      assert.equal(legacy.rows[0].refresh_token, null);
      assert.equal(accessPayload.sub, user.id);
      assert.equal(accessPayload.sid, refreshPayload.sid);
      assert.equal(accessPayload.token_type, 'access');
      assert.equal(refreshPayload.token_type, 'refresh');
      assert.equal(typeof refreshPayload.jti, 'string');
    });

    await t.test('two logins create independent sessions and both can refresh', async () => {
      const user = await createTestUser();
      const first = await login(user);
      const second = await login(user);
      const firstPayload = verifyRefreshToken(first.refreshToken);
      const secondPayload = verifyRefreshToken(second.refreshToken);

      assert.notEqual(firstPayload.sid, secondPayload.sid);
      const sessions = await pool.query(
        'SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [user.id]
      );
      assert.equal(sessions.rowCount, 2);
      await authService.refresh(first.refreshToken);
      await authService.refresh(second.refreshToken);
    });

    await t.test('rotation changes the token and reuse revokes the whole session', async () => {
      const user = await createTestUser();
      const initial = await login(user);
      const rotated = await authService.refresh(initial.refreshToken);
      const sid = verifyRefreshToken(initial.refreshToken).sid;

      assert.notEqual(rotated.refreshToken, initial.refreshToken);
      await assert.rejects(authService.refresh(initial.refreshToken), expectStatus(401));
      await assert.rejects(authService.refresh(rotated.refreshToken), expectStatus(401));

      const session = await pool.query(
        'SELECT revoked_at FROM auth_sessions WHERE id = $1',
        [sid]
      );
      assert.ok(session.rows[0].revoked_at);
    });

    await t.test('disabled accounts cannot login or refresh and their session is revoked', async () => {
      const disabled = await createTestUser({ active: false });
      await assert.rejects(login(disabled), expectStatus(403));

      const user = await createTestUser();
      const result = await login(user);
      const sid = verifyRefreshToken(result.refreshToken).sid;
      await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);

      await assert.rejects(authService.refresh(result.refreshToken), expectStatus(403));
      const session = await pool.query(
        'SELECT revoked_at FROM auth_sessions WHERE id = $1',
        [sid]
      );
      assert.ok(session.rows[0].revoked_at);
    });

    await t.test('revoked and expired sessions cannot refresh', async () => {
      const revokedUser = await createTestUser();
      const revoked = await login(revokedUser);
      const revokedSid = verifyRefreshToken(revoked.refreshToken).sid;
      await pool.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1',
        [revokedSid]
      );
      await assert.rejects(authService.refresh(revoked.refreshToken), expectStatus(401));

      const expiredUser = await createTestUser();
      const expired = await login(expiredUser);
      const expiredSid = verifyRefreshToken(expired.refreshToken).sid;
      await pool.query(
        `UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [expiredSid]
      );
      await assert.rejects(authService.refresh(expired.refreshToken), expectStatus(401));
    });

    await t.test('logout revokes only its session and does not blacklist its access token', async () => {
      const user = await createTestUser();
      const browser = await login(user);
      const phone = await login(user);
      const browserPayload = verifyAccessToken(browser.accessToken);

      await authService.logout(browserPayload.sub, browserPayload.sid);
      await assert.rejects(authService.refresh(browser.refreshToken), expectStatus(401));
      const phoneRotated = await authService.refresh(phone.refreshToken);
      assert.ok(phoneRotated.refreshToken);
      assert.equal(verifyAccessToken(browser.accessToken).sid, browserPayload.sid);
    });

    await t.test('access and refresh tokens are not interchangeable', () => {
      const userId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const access = jwt.sign(
        { sid: sessionId, token_type: 'access', plan: 'free' },
        env.JWT_SECRET,
        {
          algorithm: JWT_ALGORITHM,
          issuer: env.JWT_ISSUER,
          audience: env.JWT_ACCESS_AUDIENCE,
          subject: userId,
          expiresIn: '5m',
        }
      );
      const refresh = jwt.sign(
        { sid: sessionId, token_type: 'refresh' },
        env.JWT_REFRESH_SECRET,
        {
          algorithm: JWT_ALGORITHM,
          issuer: env.JWT_ISSUER,
          audience: env.JWT_REFRESH_AUDIENCE,
          subject: userId,
          jwtid: crypto.randomUUID(),
          expiresIn: '5m',
        }
      );

      assert.throws(() => verifyRefreshToken(access), expectStatus(401));
      assert.throws(() => verifyAccessToken(refresh), expectStatus(401));
    });

    await t.test('unexpected algorithm, type, issuer and audience are rejected', () => {
      const basePayload = {
        sub: crypto.randomUUID(),
        sid: crypto.randomUUID(),
        token_type: 'access',
      };
      const signInvalidAccess = (payload, options = {}) => jwt.sign(
        payload,
        env.JWT_SECRET,
        {
          algorithm: 'HS256',
          issuer: env.JWT_ISSUER,
          audience: env.JWT_ACCESS_AUDIENCE,
          expiresIn: '5m',
          ...options,
        }
      );

      const wrongAlgorithm = signInvalidAccess(basePayload, { algorithm: 'HS384' });
      const wrongType = signInvalidAccess({ ...basePayload, token_type: 'refresh' });
      const wrongIssuer = signInvalidAccess(basePayload, { issuer: 'wrong-issuer' });
      const wrongAudience = signInvalidAccess(basePayload, { audience: 'wrong-audience' });

      for (const token of [wrongAlgorithm, wrongType, wrongIssuer, wrongAudience]) {
        assert.throws(() => verifyAccessToken(token), expectStatus(401));
      }

      const refreshPayload = {
        sub: crypto.randomUUID(),
        sid: crypto.randomUUID(),
        jti: crypto.randomUUID(),
        token_type: 'refresh',
      };
      const signInvalidRefresh = (payload, options = {}) => jwt.sign(
        payload,
        env.JWT_REFRESH_SECRET,
        {
          algorithm: 'HS256',
          issuer: env.JWT_ISSUER,
          audience: env.JWT_REFRESH_AUDIENCE,
          expiresIn: '5m',
          ...options,
        }
      );
      const invalidRefreshTokens = [
        signInvalidRefresh(refreshPayload, { algorithm: 'HS384' }),
        signInvalidRefresh({ ...refreshPayload, token_type: 'access' }),
        signInvalidRefresh(refreshPayload, { issuer: 'wrong-issuer' }),
        signInvalidRefresh(refreshPayload, { audience: 'wrong-audience' }),
        signInvalidRefresh({ ...refreshPayload, jti: undefined }),
      ];
      for (const token of invalidRefreshTokens) {
        assert.throws(() => verifyRefreshToken(token), expectStatus(401));
      }
    });

    await t.test('simultaneous refresh permits at most one rotation', async () => {
      const user = await createTestUser();
      const initial = await login(user);
      const attempts = await Promise.allSettled([
        authService.refresh(initial.refreshToken),
        authService.refresh(initial.refreshToken),
      ]);
      const fulfilled = attempts.filter(({ status }) => status === 'fulfilled');
      const rejected = attempts.filter(({ status }) => status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.statusCode, 401);
      await assert.rejects(
        authService.refresh(fulfilled[0].value.refreshToken),
        expectStatus(401)
      );
    });

    await t.test('auth error responses do not expose tokens, hashes or internals', async () => {
      const user = await createTestUser();
      const initial = await login(user);
      await authService.refresh(initial.refreshToken);

      const app = express();
      app.use(express.json());
      app.post('/refresh', async (req, res, next) => {
        try {
          res.json(await authService.refresh(req.body.refresh_token));
        } catch (error) {
          next(error);
        }
      });
      app.use(errorHandler);

      const response = await request(app)
        .post('/refresh')
        .send({ refresh_token: initial.refreshToken });
      const serialized = JSON.stringify(response.body);

      assert.equal(response.status, 401);
      assert.equal(response.body.message, 'Invalid refresh token');
      assert.ok(!serialized.includes(initial.refreshToken));
      assert.ok(!serialized.includes(hashRefreshToken(initial.refreshToken)));
      assert.ok(!serialized.includes('auth_sessions'));
    });
  }
);
