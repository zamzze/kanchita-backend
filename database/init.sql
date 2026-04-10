CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE genres (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL UNIQUE,
  slug VARCHAR(60) NOT NULL UNIQUE
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(100),
  refresh_token TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_type  VARCHAR(20) NOT NULL DEFAULT 'free',
  status     VARCHAR(20) NOT NULL DEFAULT 'active',
  starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE movies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id          INT UNIQUE,
  title            VARCHAR(255) NOT NULL,
  original_title   VARCHAR(255),          -- nueva
  description      TEXT,
  release_year     SMALLINT,
  duration_seconds INT,
  poster_url       VARCHAR(500),
  backdrop_url     VARCHAR(500),
  rating           VARCHAR(10),
  is_published     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE series (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id      INT UNIQUE,
  title        VARCHAR(255) NOT NULL,
  original_title VARCHAR(255),            -- nueva
  description  TEXT,
  release_year SMALLINT,
  poster_url   VARCHAR(500),
  backdrop_url VARCHAR(500),
  rating       VARCHAR(10),
  status       VARCHAR(20) DEFAULT 'ongoing',
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE episodes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id        UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  tmdb_id          INT,
  season_number    SMALLINT NOT NULL DEFAULT 1,
  episode_number   SMALLINT NOT NULL,
  title            VARCHAR(255),
  description      TEXT,
  duration_seconds INT,
  thumbnail_url    VARCHAR(500),
  is_published     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, season_number, episode_number)
);

CREATE TABLE content_genres (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(10) NOT NULL CHECK (content_type IN ('movie', 'series')),
  content_id   UUID NOT NULL,
  genre_id     INT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  UNIQUE (content_type, content_id, genre_id)
);

CREATE TABLE streams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(10) NOT NULL CHECK (content_type IN ('movie', 'episode')),
  content_id   UUID NOT NULL,
  server_name  VARCHAR(100),
  quality      VARCHAR(10),
  language     VARCHAR(10) DEFAULT 'es',
  stream_url   TEXT,
  embed_url    TEXT,
  stream_type  VARCHAR(20) DEFAULT 'direct',
  priority     SMALLINT DEFAULT 1,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE watch_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type     VARCHAR(10) NOT NULL CHECK (content_type IN ('movie', 'episode')),
  content_id       UUID NOT NULL,
  progress_seconds INT NOT NULL DEFAULT 0,
  duration_seconds INT,
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  last_watched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, content_type, content_id)
);

CREATE TABLE scraper_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type  VARCHAR(10) NOT NULL,
  content_id    UUID NOT NULL,
  tmdb_id       INT NOT NULL,
  provider      VARCHAR(100),
  status        VARCHAR(20) NOT NULL,
  streams_found INT DEFAULT 0,
  error_message TEXT,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX idx_streams_content     ON streams (content_type, content_id) WHERE is_active = TRUE;
CREATE INDEX idx_watch_history_user  ON watch_history (user_id, last_watched_at DESC);
CREATE INDEX idx_episodes_series     ON episodes (series_id, season_number, episode_number);
CREATE INDEX idx_content_genres      ON content_genres (content_type, content_id);
CREATE INDEX idx_subscriptions_user  ON subscriptions (user_id) WHERE status = 'active';
CREATE INDEX idx_scraper_log_tmdb    ON scraper_log (tmdb_id, executed_at DESC);
CREATE INDEX idx_movies_tmdb         ON movies (tmdb_id);
CREATE INDEX idx_series_tmdb         ON series (tmdb_id);