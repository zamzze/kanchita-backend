const rateLimit = require('express-rate-limit');

const rateLimitMessage = (message) => ({
  success: false,
  code: 'RATE_LIMITED',
  message,
});

const createDefaultLimiter = (overrides = {}) => rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              300,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: rateLimitMessage('Too many requests, please try again later.'),
  ...overrides,
});

const defaultLimiter = createDefaultLimiter();

const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutos
  max:              10,              // solo 10 intentos de login por ventana
  standardHeaders:  true,
  legacyHeaders:    false,
  message: rateLimitMessage('Too many authentication attempts, please try again later.'),
});

const searchLimiter = rateLimit({
  windowMs:         60 * 1000, // 1 minuto
  max:              30,         // 30 búsquedas por minuto
  standardHeaders:  true,
  legacyHeaders:    false,
  message: rateLimitMessage('Too many search requests, please slow down.'),
});

module.exports = {
  createDefaultLimiter,
  defaultLimiter,
  authLimiter,
  searchLimiter,
};
