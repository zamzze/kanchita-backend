const ok = (res, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

const created = (res, data) => ok(res, data, 201);

const error = (res, message, statusCode = 400) =>
  res.status(statusCode).json({ success: false, message });

module.exports = { ok, created, error };