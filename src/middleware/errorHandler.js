const { codeForStatus } = require('../utils/response');
const { redactSensitive } = require('../utils/redact');

module.exports = (err, req, res, next) => {
  const requestedStatus = Number(err.statusCode);
  const statusCode = requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 500;
  const isServerError = statusCode >= 500;
  const safeServerError = isServerError && err.safeToExpose === true &&
    err.code === 'STREAM_TEMPORARILY_UNAVAILABLE';
  const code = (!isServerError || safeServerError) && /^[A-Z0-9_]+$/.test(err.code || '')
    ? err.code
    : isServerError
      ? 'INTERNAL_ERROR'
      : codeForStatus(statusCode);
  const message = isServerError && !safeServerError
    ? 'Internal server error'
    : err.message || 'Request failed';

  if (isServerError) {
    const requestPath = (req.originalUrl || req.url || '').split('?')[0];
    console.error(
      `[HTTP] ${req.method} ${requestPath} failed: ${redactSensitive(err.message)}`
    );
  }

  res.status(statusCode).json({
    success: false,
    code,
    message,
  });
};
