const scheduler = require('./scheduler/contentScheduler');

const initIngestion = () => {
  scheduler.start();
};

module.exports = { initIngestion };