const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const normalizeMovie = (tmdbMovie) => ({
  tmdb_id:          tmdbMovie.id,
  title:            tmdbMovie.title,
  original_title:   tmdbMovie.original_title || tmdbMovie.title,
  description:      tmdbMovie.overview || null,
  release_year:     tmdbMovie.release_date ? parseInt(tmdbMovie.release_date.slice(0, 4)) : null,
  duration_seconds: tmdbMovie.runtime ? tmdbMovie.runtime * 60 : null,
  poster_url:       tmdbMovie.poster_path   ? `${TMDB_IMAGE_BASE}${tmdbMovie.poster_path}`   : null,
  backdrop_url:     tmdbMovie.backdrop_path ? `${TMDB_IMAGE_BASE}${tmdbMovie.backdrop_path}` : null,
  rating:           tmdbMovie.adult ? 'R' : 'PG-13',
  genres:           tmdbMovie.genres || [],
  is_published:     true,
});

const normalizeSeries = (tmdbSeries) => ({
  tmdb_id:      tmdbSeries.id,
  title:        tmdbSeries.name,
  description:  tmdbSeries.overview || null,
  release_year: tmdbSeries.first_air_date ? parseInt(tmdbSeries.first_air_date.slice(0, 4)) : null,
  poster_url:   tmdbSeries.poster_path   ? `${TMDB_IMAGE_BASE}${tmdbSeries.poster_path}`   : null,
  backdrop_url: tmdbSeries.backdrop_path ? `${TMDB_IMAGE_BASE}${tmdbSeries.backdrop_path}` : null,
  rating:       tmdbSeries.adult ? 'R' : 'TV-PG',
  status:       tmdbSeries.status === 'Ended' ? 'ended' : 'ongoing',
  seasons:      tmdbSeries.number_of_seasons || 1,
  genres:       tmdbSeries.genres || [],
  is_published: true,
});

const normalizeEpisode = (tmdbEpisode, seriesId) => ({
  series_id:        seriesId,
  tmdb_id:          tmdbEpisode.id,
  season_number:    tmdbEpisode.season_number,
  episode_number:   tmdbEpisode.episode_number,
  title:            tmdbEpisode.name || null,
  description:      tmdbEpisode.overview || null,
  duration_seconds: tmdbEpisode.runtime ? tmdbEpisode.runtime * 60 : null,
  thumbnail_url:    tmdbEpisode.still_path ? `${TMDB_IMAGE_BASE}${tmdbEpisode.still_path}` : null,
  is_published:     true,
});

module.exports = { normalizeMovie, normalizeSeries, normalizeEpisode };