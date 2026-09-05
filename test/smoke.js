'use strict';

const assert = require('node:assert/strict');
const cron = require('node-cron');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://smoke:smoke@127.0.0.1:5432/smoke';
process.env.JWT_SECRET ||= 'smoke-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'smoke-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'smoke-test-tmdb-key';

const tasksBeforeLoad = cron.getTasks().size;
const app = require('../src/app');
const pool = require('../src/config/db');

assert.equal(typeof app, 'function', 'src/app must export an Express application');
assert.equal(
  cron.getTasks().size,
  tasksBeforeLoad,
  'loading the app in test mode must not schedule ingestion jobs'
);

pool.end()
  .then(() => {
    console.log('Smoke test passed: app loaded without scheduling ingestion.');
  })
  .catch((error) => {
    console.error('Smoke test failed while closing the database pool:', error.message);
    process.exitCode = 1;
  });

