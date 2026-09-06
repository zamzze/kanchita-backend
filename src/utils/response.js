const ok = (res, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

const created = (res, data) => ok(res, data, 201);

const codeForStatus = (statusCode) => ({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
}[statusCode] || 'REQUEST_ERROR');

const error = (res, message, statusCode = 400, code = codeForStatus(statusCode)) =>
  res.status(statusCode).json({ success: false, code, message });

module.exports = { ok, created, error, codeForStatus };
