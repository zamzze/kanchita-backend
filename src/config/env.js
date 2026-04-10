const required = [
  'PORT',
  'DB_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'TMDB_API_KEY',       // nuevo
];

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
  NODE_ENV:           process.env.NODE_ENV        || 'development',
  TMDB_API_KEY:       process.env.TMDB_API_KEY,   // nuevo
  PROVIDER_A_URL:     process.env.PROVIDER_A_URL,
  API_BASE_URL: process.env.API_BASE_URL
};