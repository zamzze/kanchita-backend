const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const authRoutes    = require('./modules/auth/auth.routes');
const moviesRoutes  = require('./modules/movies/movies.routes');
const seriesRoutes  = require('./modules/series/series.routes');
const streamsRoutes = require('./modules/streams/streams.routes');
const historyRoutes = require('./modules/history/history.routes');
const contentRoutes = require('./modules/content/content.routes');  // nuevo
const errorHandler  = require('./middleware/errorHandler');
const { initIngestion } = require('./ingestion');
const { defaultLimiter } = require('./middleware/rateLimiter');


const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/api/auth',    authRoutes);
app.use('/api/movies',  moviesRoutes);
app.use('/api/series',  seriesRoutes);
app.use('/api/streams', streamsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/content', contentRoutes);  // nuevo
app.use('/api/', defaultLimiter);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  initIngestion();
}

module.exports = app;