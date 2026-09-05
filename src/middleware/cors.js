const cors = require('cors');

const normalizeOrigin = (origin) => origin.trim().replace(/\/$/, '');

const createCorsMiddleware = (origins = []) => {
  const allowedOrigins = new Set(origins.map(normalizeOrigin));

  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
        return callback(null, true);
      }

      const error = new Error('Origin not allowed');
      error.statusCode = 403;
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    },
    optionsSuccessStatus: 204,
  });
};

module.exports = { createCorsMiddleware };
