const historyDb = require('../../db/history.queries');

const updateProgress = async (userId, { content_type, content_id, progress_seconds, duration_seconds }) => {
  if (!['movie', 'episode'].includes(content_type)) {
    const err = new Error('Invalid content_type');
    err.statusCode = 400;
    throw err;
  }
  if (typeof progress_seconds !== 'number' || progress_seconds < 0) {
    const err = new Error('progress_seconds must be a non-negative number');
    err.statusCode = 400;
    throw err;
  }

  return historyDb.upsertProgress({ userId, contentType: content_type, contentId: content_id, progressSeconds: progress_seconds, durationSeconds: duration_seconds });
};

const getHistory = async (userId, { page = 1, limit = 20 } = {}) => {
  const safePage  = Math.max(1, parseInt(page, 10));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const offset    = (safePage - 1) * safeLimit;
  return historyDb.findByUser(userId, { limit: safeLimit, offset });
};

const getProgress = async (userId, contentType, contentId) => {
  return historyDb.findOne(userId, contentType, contentId) || { progress_seconds: 0, completed: false };
};

module.exports = { updateProgress, getHistory, getProgress };