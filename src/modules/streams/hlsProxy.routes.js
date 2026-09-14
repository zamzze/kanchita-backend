'use strict';

const express = require('express');

const createHlsProxyRouter = (proxy) => {
  const router = express.Router();
  router.get('/:token', (req, res, next) => proxy.handle(req, res, next));
  return router;
};

module.exports = { createHlsProxyRouter };
