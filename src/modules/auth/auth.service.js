'use strict';

const crypto = require('node:crypto');
const defaultPool = require('../../config/db');
const { hashPassword, comparePassword } = require('../../utils/hash');
const {
  findUserByEmail,
  createUser,
  getActiveSubscription,
} = require('../../db/auth.queries');
const { createAuthSessionStore } = require('../../db/authSessions.queries');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../../utils/jwt');
const {
  hashRefreshToken,
  refreshTokenHashMatches,
} = require('../../utils/tokenHash');

const authError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const issueTokenPair = ({ userId, sessionId, planType }) => {
  const refreshToken = signRefreshToken({
    id: userId,
    sessionId,
    tokenId: crypto.randomUUID(),
  });
  const refreshPayload = verifyRefreshToken(refreshToken);

  return {
    accessToken: signAccessToken({
      id: userId,
      sessionId,
      plan_type: planType,
    }),
    refreshToken,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(refreshPayload.exp * 1000),
  };
};

const createAuthService = ({ pool = defaultPool } = {}) => {
  const sessions = createAuthSessionStore(pool);

  const register = async ({ email, password, displayName }) => {
    const existing = await findUserByEmail(email, pool);
    if (existing) throw authError('Email already in use', 409);

    const passwordHash = await hashPassword(password);
    return createUser({ email, passwordHash, displayName }, pool);
  };

  const login = async ({ email, password }) => {
    const user = await findUserByEmail(email, pool);
    if (!user) throw authError('Invalid credentials', 401);
    if (!user.is_active) throw authError('Account disabled', 403);

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) throw authError('Invalid credentials', 401);

    const subscription = await getActiveSubscription(user.id, pool);
    const planType = subscription?.plan_type || 'free';
    const sessionId = crypto.randomUUID();
    const tokens = issueTokenPair({ userId: user.id, sessionId, planType });

    await sessions.createSession({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: tokens.refreshTokenHash,
      expiresAt: tokens.expiresAt,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan_type: planType,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  };

  const refresh = async (token) => {
    const payload = verifyRefreshToken(token);
    const result = await sessions.withLockedSession(
      { sessionId: payload.sid, userId: payload.sub },
      async (client, session) => {
        if (!session) return { status: 'invalid' };

        if (!session.is_active) {
          await sessions.revokeLockedSession(client, session.id);
          return { status: 'disabled' };
        }

        if (session.revoked_at || new Date(session.expires_at) <= new Date()) {
          await sessions.revokeLockedSession(client, session.id);
          return { status: 'invalid' };
        }

        if (!refreshTokenHashMatches(token, session.refresh_token_hash)) {
          await sessions.revokeLockedSession(client, session.id);
          return { status: 'invalid' };
        }

        const tokens = issueTokenPair({
          userId: session.user_id,
          sessionId: session.id,
          planType: session.plan_type,
        });
        await sessions.rotateSession(client, {
          sessionId: session.id,
          refreshTokenHash: tokens.refreshTokenHash,
          expiresAt: tokens.expiresAt,
        });
        return { status: 'rotated', tokens };
      }
    );

    if (result.status === 'disabled') throw authError('Account disabled', 403);
    if (result.status !== 'rotated') throw authError('Invalid refresh token', 401);

    return {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
    };
  };

  const logout = async (userId, sessionId) => {
    await sessions.revokeSession(userId, sessionId);
  };

  return { register, login, refresh, logout };
};

module.exports = {
  ...createAuthService(),
  createAuthService,
};
