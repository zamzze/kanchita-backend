const express = require('express');
const path    = require('path');
const app     = require('./src/app');
const { PORT } = require('./src/config/env');
const subtitlesRoutes  = require('./src/modules/subtitles/subtitles.routes');

// Servir archivos .vtt estáticos
app.use('/subtitles', express.static(path.join(__dirname, 'public/subtitles')));

// Ruta API
app.use('/api/subtitles', subtitlesRoutes);

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

