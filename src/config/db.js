const { Pool } = require('pg');
const { DB_URL } = require('./env');
const { redactSensitive } = require('../utils/redact');

const pool = new Pool({ connectionString: DB_URL });

pool.on('error', (err) => {
  console.error('Unexpected DB error:', redactSensitive(err.message));
  process.exit(-1);
});

module.exports = pool;
