const https = require('https');

const TMDB_BASE    = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const get = (path, params = {}) => {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'es-ES', ...params });
    const url   = `${TMDB_BASE}${path}?${query}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status_code) {
            reject(new Error(`TMDB error: ${parsed.status_message}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
};

module.exports = { get };