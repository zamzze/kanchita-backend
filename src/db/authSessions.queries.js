'use strict';

const defaultPool = require('../config/db');

const createAuthSessionStore = (pool = defaultPool) => {
  const createSession = async ({ id, userId, refreshTokenHash, expiresAt }) => {
    const { rows } = await pool.query(
      `INSERT INTO auth_sessions
         (id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, expires_at, created_at, last_used_at, revoked_at`,
      [id, userId, refreshTokenHash, expiresAt]
    );
    return rows[0];
  };

  const withLockedSession = async ({ sessionId, userId }, handler) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT
           session.id,
           session.user_id,
           session.refresh_token_hash,
           session.expires_at,
           session.last_used_at,
           session.revoked_at,
           users.email,
           users.is_active,
           COALESCE(subscription.plan_type, 'free') AS plan_type
         FROM auth_sessions AS session
         JOIN users ON users.id = session.user_id
         LEFT JOIN LATERAL (
           SELECT plan_type
           FROM subscriptions
           WHERE user_id = users.id
             AND status = 'active'
             AND (ends_at IS NULL OR ends_at > NOW())
           ORDER BY created_at DESC
           LIMIT 1
         ) AS subscription ON TRUE
         WHERE session.id = $1 AND session.user_id = $2
         FOR UPDATE OF session`,
        [sessionId, userId]
      );

      const result = await handler(client, rows[0] || null);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const rotateSession = (client, {
    sessionId,
    refreshTokenHash,
    expiresAt,
  }) => client.query(
    `UPDATE auth_sessions
     SET refresh_token_hash = $1,
         expires_at = $2,
         last_used_at = NOW()
     WHERE id = $3`,
    [refreshTokenHash, expiresAt, sessionId]
  );

  const revokeLockedSession = (client, sessionId) => client.query(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1`,
    [sessionId]
  );

  const revokeSession = (userId, sessionId) => pool.query(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );

  return {
    createSession,
    withLockedSession,
    rotateSession,
    revokeLockedSession,
    revokeSession,
  };
};

module.exports = { createAuthSessionStore };
