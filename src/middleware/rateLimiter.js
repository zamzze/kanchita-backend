const rateLimit = require('express-rate-limit');

const defaultLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutos
  max:              100,             // 100 requests por ventana
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
});

const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutos
  max:              10,              // solo 10 intentos de login por ventana
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    message: 'Too many login attempts, please try again later.',
  },
});

const searchLimiter = rateLimit({
  windowMs:         60 * 1000, // 1 minuto
  max:              30,         // 30 búsquedas por minuto
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    message: 'Too many search requests, please slow down.',
  },
});

module.exports = { defaultLimiter, authLimiter, searchLimiter };