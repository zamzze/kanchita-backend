'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://subtitle:subtitle@127.0.0.1:5432/subtitle';
process.env.JWT_SECRET ||= 'subtitle-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'subtitle-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'subtitle-test-tmdb-key';

const {
  createSubtitleService,
  rankSubtitles,
  subtitleScore,
} = require('../../src/modules/subtitles/subtitles.service');

test('subtitle scoring prefers Latino, release compatibility and episode match', () => {
  const generic = { release_name: 'Movie.1080p.WEB-DL Spanish', downloads: 5000 };
  const latino = { release_name: 'Movie.720p.WEBRip.es-419.Latino', downloads: 10 };
  assert.ok(subtitleScore(latino) > subtitleScore(generic));
  assert.equal(rankSubtitles([generic, latino])[0], latino);

  const wrongEpisode = { release_name: 'Series.S01E03.WEB-DL.Spanish' };
  const exactEpisode = { release_name: 'Series.S01E02.WEB-DL.Spanish' };
  assert.equal(
    rankSubtitles([wrongEpisode, exactEpisode], { season: 1, episode: 2 })[0],
    exactEpisode
  );
});

test('generic Spanish remains the fallback when Latino is absent', () => {
  const english = { release_name: 'Movie.1080p.WEB-DL.English' };
  const spanish = { release_name: 'Movie.720p.WEBRip.Spanish' };
  assert.equal(rankSubtitles([english, spanish])[0], spanish);
});

test('subtitle service keeps cache and provider fallback generic for movies and episodes', async (t) => {
  const rows = [];
  const db = {
    query: async (sql, values) => {
      if (sql.includes('SELECT subtitle_url')) {
        return { rows: rows.filter((row) =>
          row.content_type === values[0] && row.content_id === values[1]) };
      }
      if (sql.includes('INSERT INTO subtitles')) {
        rows.splice(0, rows.length, {
          content_type: values[0], content_id: values[1], subtitle_url: values[2], language: 'es',
        });
      }
      return { rows: [] };
    },
  };
  const calls = [];
  const service = createSubtitleService({
    db,
    subdlFinder: async (...args) => { calls.push(['subdl', ...args]); return null; },
    openSubtitlesFinder: async (...args) => {
      calls.push(['open', ...args]);
      return { url: 'https://subtitles.example/fixture.srt' };
    },
    downloader: async (url, contentId, season, episode) => {
      calls.push(['download', url, contentId, season, episode]);
      return `/subtitles/${contentId}.vtt`;
    },
    fileExists: () => true,
    metrics: { increment: async () => {} },
    subdlEnabled: () => true,
    openSubtitlesEnabled: () => true,
    logger: { log() {}, warn() {} },
  });

  await t.test('movie falls back from SubDL to optional OpenSubtitles', async () => {
    const result = await service.getSubtitle(10, 'movie', 'movie-id');
    assert.equal(result.language, 'es');
    assert.deepEqual(calls[0], ['subdl', 10, 'movie', null, null]);
    assert.deepEqual(calls[1], ['open', 10, 'movie', null, null]);
  });

  await t.test('cached movie avoids all providers', async () => {
    calls.length = 0;
    const result = await service.getSubtitle(10, 'movie', 'movie-id');
    assert.match(result.subtitle_url, /movie-id\.vtt$/);
    assert.equal(calls.length, 0);
  });

  await t.test('episode forwards season and episode to providers', async () => {
    rows.length = 0;
    calls.length = 0;
    await service.getSubtitle(20, 'episode', 'episode-id', 2, 7);
    assert.deepEqual(calls[0], ['subdl', 20, 'tv', 2, 7]);
    assert.deepEqual(calls[1], ['open', 20, 'tv', 2, 7]);
  });
});
