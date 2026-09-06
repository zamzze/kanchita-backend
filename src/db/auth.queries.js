const pool = require('../config/db');

const findUserByEmail = async (email, db = pool) => {
  const { rows } = await db.query(
    'SELECT id, email, password_hash, display_name, is_active FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
};

const createUser = async ({ email, passwordHash, displayName }, db = pool) => {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName]
  );
  return rows[0];
};

const getActiveSubscription = async (userId, db = pool) => {
  const { rows } = await db.query(
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
  getActiveSubscription,
};
