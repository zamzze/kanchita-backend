const { Pool } = require('pg');
const { DB_URL } = require('./env');

const pool = new Pool({ connectionString: DB_URL });

pool.on('error', (err) => {
  console.error('Unexpected DB error', err);
  process.exit(-1);
});

module.exports = pool;