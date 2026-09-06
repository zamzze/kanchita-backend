const required = [
  'PORT',
  'DB_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'TMDB_API_KEY',       // nuevo
];

const parseCorsOrigins = (value = '') =>
  [...new Set(
    value
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean)
  )];

const isExplicitlyEnabled = (value) => value === 'true';

const positiveInteger = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
};

required.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
});

module.exports = {
  PORT:               process.env.PORT || 3000,
  DB_URL:             process.env.DB_URL,
  JWT_SECRET:         process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN:     process.env.JWT_EXPIRES_IN  || '15m',
  JWT_REFRESH_IN:     process.env.JWT_REFRESH_IN  || '7d',
  JWT_ISSUER:         process.env.JWT_ISSUER || 'kanchita-api',
  JWT_ACCESS_AUDIENCE: process.env.JWT_ACCESS_AUDIENCE || 'kanchita-clients',
  JWT_REFRESH_AUDIENCE: process.env.JWT_REFRESH_AUDIENCE || 'kanchita-refresh',
  NODE_ENV:           process.env.NODE_ENV        || 'development',
  TMDB_API_KEY:       process.env.TMDB_API_KEY,   // nuevo
  PROVIDER_A_URL:     process.env.PROVIDER_A_URL,
  API_BASE_URL:       process.env.API_BASE_URL,
  CORS_ORIGINS:       parseCorsOrigins(process.env.CORS_ORIGINS),
  ALLOW_PUBLIC_REGISTRATION: isExplicitlyEnabled(
    process.env.ALLOW_PUBLIC_REGISTRATION
  ),
  STREAM_CACHE_TTL_MINUTES: positiveInteger('STREAM_CACHE_TTL_MINUTES', 60),
  STREAM_VERIFY_INTERVAL_MINUTES: positiveInteger('STREAM_VERIFY_INTERVAL_MINUTES', 10),
  STREAM_VERIFY_TIMEOUT_MS: positiveInteger('STREAM_VERIFY_TIMEOUT_MS', 5000),
  STREAM_MAX_MANIFEST_BYTES: positiveInteger('STREAM_MAX_MANIFEST_BYTES', 256 * 1024),
  STREAM_LOCK_TIMEOUT_MS: positiveInteger('STREAM_LOCK_TIMEOUT_MS', 5000),
  parseCorsOrigins,
  isExplicitlyEnabled,
  positiveInteger,
};
