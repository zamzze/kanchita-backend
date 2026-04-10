const pool = require('../config/db');

const findUserByEmail = async (email) => {
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, display_name, is_active FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
};

const createUser = async ({ email, passwordHash, displayName }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName]
  );
  return rows[0];
};

const saveRefreshToken = async (userId, token) => {
  await pool.query(
    'UPDATE users SET refresh_token = $1, updated_at = NOW() WHERE id = $2',
    [token, userId]
  );
};

const findUserByRefreshToken = async (token) => {
  const { rows } = await pool.query(
    'SELECT id, email, is_active FROM users WHERE refresh_token = $1',
    [token]
  );
  return rows[0] || null;
};

const clearRefreshToken = async (userId) => {
  await pool.query(
    'UPDATE users SET refresh_token = NULL, updated_at = NOW() WHERE id = $1',
    [userId]
  );
};

const getActiveSubscription = async (userId) => {
  const { rows } = await pool.query(
    `SELECT plan_type FROM subscriptions
     WHERE user_id = $1 AND status = 'active'
       AND (ends_at IS NULL OR ends_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
};

module.exports = {
  findUserByEmail,
  createUser,
  saveRefreshToken,
  findUserByRefreshToken,
  clearRefreshToken,
  getActiveSubscription,
};