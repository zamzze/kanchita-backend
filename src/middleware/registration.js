const { error } = require('../utils/response');

const requirePublicRegistration = (req, res, next) => {
  if (req.app.locals.allowPublicRegistration === true) {
    return next();
  }

  return error(
    res,
    'Public registration is disabled',
    403,
    'REGISTRATION_DISABLED'
  );
};

module.exports = requirePublicRegistration;
