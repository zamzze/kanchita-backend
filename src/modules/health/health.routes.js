'use strict';

const express = require('express');
const auth = require('../../middleware/auth');
const { createHealthService } = require('./health.service');

const createHealthRouter = (service = createHealthService()) => {
  const router = express.Router();
  router.get('/live', async (req, res, next) => {
    try {
      return res.status(200).json(await service.live());
    } catch (error) {
      return next(error);
    }
  });
  router.get('/ready', async (req, res, next) => {
    try {
      return res.status(200).json(await service.ready());
    } catch (error) {
      return next(error);
    }
  });
  return router;
};

const createInternalHealthRouter = (service = createHealthService()) => {
  const router = express.Router();
  router.get('/stream-health', auth, async (req, res, next) => {
    try {
      return res.status(200).json({ data: await service.streamHealth() });
    } catch (error) {
      return next(error);
    }
  });
  return router;
};

module.exports = { createHealthRouter, createInternalHealthRouter };
