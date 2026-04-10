const tmdb = require('./tmdbClient');

const getTrendingMovies = (page = 1) =>
  tmdb.get('/trending/movie/week', { page });

const getTrendingSeries = (page = 1) =>
  tmdb.get('/trending/tv/week', { page });

const getMovieDetail = (tmdbId) =>
  tmdb.get(`/movie/${tmdbId}`, { append_to_response: 'genres' });

const getSeriesDetail = (tmdbId) =>
  tmdb.get(`/tv/${tmdbId}`, { append_to_response: 'genres' });

const getSeriesSeason = (tmdbId, seasonNumber) =>
  tmdb.get(`/tv/${tmdbId}/season/${seasonNumber}`);

const search = async (endpoint, query) => {
  const res = await tmdb.get(endpoint, { query, include_adult: false });
  return res.results || [];
};

module.exports = {
  getTrendingMovies,
  getTrendingSeries,
  getMovieDetail,
  getSeriesDetail,
  getSeriesSeason,
  search,
};