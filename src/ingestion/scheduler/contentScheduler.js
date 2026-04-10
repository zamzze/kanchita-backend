const cron = require('node-cron');
const { runIngestionJob } = require('../ingestionService');

let isRunning = false;

const start = () => {
  // Cada 6 horas: 0 */6 * * *
  cron.schedule('0 */6 * * *', async () => {
    if (isRunning) {
      console.log('[Scheduler] Job already running, skipping.');
      return;
    }
    isRunning = true;
    try {
      await runIngestionJob();
    } finally {
      isRunning = false;
    }
  });

  console.log('[Scheduler] Content ingestion scheduler started (every 6h)');
};

module.exports = { start };