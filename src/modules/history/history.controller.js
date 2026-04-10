const historyService = require('./history.service');
const { ok, error }  = require('../../utils/response');

const saveProgress = async (req, res, next) => {
  try {
    const { content_type, content_id, progress_seconds, duration_seconds } = req.body;

    if (!content_type || !content_id) {
      return error(res, 'content_type and content_id are required', 400);
    }
    if (!['movie', 'episode'].includes(content_type)) {
      return error(res, 'content_type must be movie or episode', 400);
    }
    if (typeof progress_seconds !== 'number' || progress_seconds < 0) {
      return error(res, 'progress_seconds must be a non-negative number', 400);
    }

    const result = await historyService.updateProgress(req.user.sub, {
      content_type,
      content_id,
      progress_seconds,
      duration_seconds: duration_seconds || null,
    });

    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const listHistory = async (req, res, next) => {
  try {
    const { page = 1 } = req.query;
    const result = await historyService.getHistory(req.user.sub, { page });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

const fetchProgress = async (req, res, next) => {
  try {
    const { content_type, content_id } = req.params;

    if (!['movie', 'episode'].includes(content_type)) {
      return error(res, 'content_type must be movie or episode', 400);
    }

    const result = await historyService.getProgress(
      req.user.sub,
      content_type,
      content_id
    );

    return ok(res, result);
  } catch (err) {
    next(err);
  }
};

module.exports = { saveProgress, listHistory, fetchProgress };