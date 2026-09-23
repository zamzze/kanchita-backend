const tmdb = require('./tmdbClient');

const getTrendingMovies = (page = 1) =>
  tmdb.get('/trending/movie/week', { page });

const getTrendingSeries = (page = 1) =>
  tmdb.get('/trending/tv/week', { page });

const discoverCatalogPage = (contentType, year, page = 1) => {
  if (!['movie', 'series'].includes(contentType) || !Number.isInteger(year) ||
      year < 1900 || year > 2100 || !Number.isInteger(page) || page < 1 || page > 500) {
    throw Object.assign(new Error('TMDB_DISCOVER_INVALID_INPUT'),
      { code: 'TMDB_DISCOVER_INVALID_INPUT' });
  }
  const movie = contentType === 'movie';
  const dateField = movie ? 'primary_release_date' : 'first_air_date';
  return tmdb.get(movie ? '/discover/movie' : '/discover/tv', {
    page,
    sort_by: 'popularity.desc',
    include_adult: false,
    [`${dateField}.gte`]: `${year}-01-01`,
    [`${dateField}.lte`]: `${year}-12-31`,
  });
};

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
  discoverCatalogPage,
  getMovieDetail,
  getSeriesDetail,
  getSeriesSeason,
  search,
};
