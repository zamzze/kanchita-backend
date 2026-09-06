const express = require('express');
const path    = require('path');
const helmet  = require('helmet');

const authRoutes    = require('./modules/auth/auth.routes');
const moviesRoutes  = require('./modules/movies/movies.routes');
const seriesRoutes  = require('./modules/series/series.routes');
const { createSeriesRouter } = seriesRoutes;
const streamsRoutes = require('./modules/streams/streams.routes');
const { createStreamsRouter } = streamsRoutes;
const historyRoutes = require('./modules/history/history.routes');
const contentRoutes = require('./modules/content/content.routes');  // nuevo
const subtitlesRoutes = require('./modules/subtitles/subtitles.routes');
const {
  createHealthRouter,
  createInternalHealthRouter,
} = require('./modules/health/health.routes');
const errorHandler  = require('./middleware/errorHandler');
const { initIngestion } = require('./ingestion');
const { createCorsMiddleware } = require('./middleware/cors');
const { createDefaultLimiter } = require('./middleware/rateLimiter');
const { error } = require('./utils/response');
const {
  CORS_ORIGINS,
  ALLOW_PUBLIC_REGISTRATION,
} = require('./config/env');

const DEFAULT_SUBTITLES_DIR = path.join(__dirname, '../public/subtitles');

const createApp = ({
  corsOrigins = CORS_ORIGINS,
  allowPublicRegistration = ALLOW_PUBLIC_REGISTRATION,
  subtitlesDir = DEFAULT_SUBTITLES_DIR,
  apiLimiter = createDefaultLimiter(),
  streamsService,
  seriesService,
  healthService,
} = {}) => {
  const app = express();
  app.locals.allowPublicRegistration = allowPublicRegistration === true;

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(createCorsMiddleware(corsOrigins));
  app.use(express.json());

  app.use('/subtitles', express.static(subtitlesDir));
  app.use('/health', createHealthRouter(healthService));

  app.use('/api', apiLimiter);
  app.use('/api/auth',      authRoutes);
  app.use('/api/movies',    moviesRoutes);
  app.use('/api/series', seriesService
    ? createSeriesRouter(seriesService)
    : seriesRoutes);
  app.use('/api/streams', streamsService
    ? createStreamsRouter(streamsService)
    : streamsRoutes);
  app.use('/api/history',   historyRoutes);
  app.use('/api/content',   contentRoutes);
  app.use('/api/subtitles', subtitlesRoutes);
  app.use('/api/internal', createInternalHealthRouter(healthService));

  app.use((req, res) => error(res, 'Not found', 404));
  app.use(errorHandler);

  return app;
};

const app = createApp();

if (process.env.NODE_ENV !== 'test') initIngestion();

module.exports = app;
module.exports.createApp = createApp;
