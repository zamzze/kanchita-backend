const bcrypt = require('bcryptjs');
const { hashPassword, comparePassword } = require('../../utils/hash');
const {
  findUserByEmail,
  createUser,
  saveRefreshToken,
  findUserByRefreshToken,
  clearRefreshToken,
  getActiveSubscription,
} = require('../../db/auth.queries');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/jwt');

const SALT_ROUNDS = 12;

const register = async ({ email, password, displayName }) => {
  const existing = await findUserByEmail(email);
  if (existing) {
    const err = new Error('Email already in use');
    err.statusCode = 409;
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({ email, passwordHash, displayName });
  return user;
};

const login = async ({ email, password }) => {
  const user = await findUserByEmail(email);
  if (!user) {
    const err = new Error('Invalid credentials');
    err.statusCode = 401;
    throw err;
  }

  if (!user.is_active) {
    const err = new Error('Account disabled');
    err.statusCode = 403;
    throw err;
  }

  const valid = await comparePassword(password, user.password_hash)
  if (!valid) {
    const err = new Error('Invalid credentials');
    err.statusCode = 401;
    throw err;
  }

  const subscription = await getActiveSubscription(user.id);
  const plan_type    = subscription?.plan_type || 'free';

  const accessToken  = signAccessToken({ id: user.id, email: user.email, plan_type });
  const refreshToken = signRefreshToken({ id: user.id });

  await saveRefreshToken(user.id, refreshToken);

  return {
    user: { id: user.id, email: user.email, display_name: user.display_name, plan_type },
    accessToken,
    refreshToken,
  };
};

const refresh = async (token) => {
  const payload = verifyRefreshToken(token); // lanza si inválido
  const user    = await findUserByRefreshToken(token);

  if (!user || user.id !== payload.sub) {
    const err = new Error('Invalid refresh token');
    err.statusCode = 401;
    throw err;
  }

  const subscription = await getActiveSubscription(user.id);
  const plan_type    = subscription?.plan_type || 'free';

  const accessToken  = signAccessToken({ id: user.id, email: user.email, plan_type });
  const refreshToken = signRefreshToken({ id: user.id });

  await saveRefreshToken(user.id, refreshToken);

  return { accessToken, refreshToken };
};

const logout = async (userId) => {
  await clearRefreshToken(userId);
};

module.exports = { register, login, refresh, logout };