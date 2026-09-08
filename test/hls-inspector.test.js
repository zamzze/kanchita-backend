'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { inspectHlsManifest, parseAttributeList } =
  require('../src/modules/streams/resolverV2/hlsInspector');

const fixtures = path.join(__dirname, 'fixtures', 'streams');
const readFixture = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');

test('attribute parser keeps commas inside quoted CODECS values', () => {
  assert.deepEqual(parseAttributeList(
    'BANDWIDTH=6000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080'
  ), { BANDWIDTH: '6000000', CODECS: 'avc1.640028,mp4a.40.2', RESOLUTION: '1920x1080' });
});

test('master playlist exposes normalized variants and resolves relative URLs', () => {
  const result = inspectHlsManifest(readFixture('master-simple.m3u8'), {
    baseUrl: 'https://media.example.test/catalog/master.m3u8',
  });
  assert.equal(result.isHls, true);
  assert.equal(result.isMaster, true);
  assert.equal(result.isMediaPlaylist, false);
  assert.equal(result.variants.length, 3);
  assert.deepEqual(result.variants[1], {
    url: 'https://media.example.test/catalog/720/playlist.m3u8',
    bandwidth: 2800000, averageBandwidth: 2500000,
    resolution: '1280x720', width: 1280, height: 720,
    codecs: 'avc1.4d401f,mp4a.40.2', frameRate: 29.97,
    audioGroup: null, subtitleGroup: null,
  });
  assert.equal(result.variants[2].url, 'https://video.example.test/1080/playlist.m3u8');
});

test('multi-audio master detects es-419, es and en tracks', () => {
  const result = inspectHlsManifest(readFixture('master-multiaudio.m3u8'), {
    baseUrl: 'https://media.example.test/title/master.m3u8',
  });
  assert.deepEqual(result.audioTracks.map(({ language }) => language), ['es-419', 'en', 'es']);
  assert.equal(result.audioTracks[0].default, true);
  assert.equal(result.audioTracks[1].default, false);
  assert.equal(result.audioTracks[0].uri, 'https://media.example.test/title/audio/es-419.m3u8');
  assert.equal(result.variants[0].audioGroup, 'audio-main');
});

test('subtitle master detects languages, flags and groups', () => {
  const result = inspectHlsManifest(readFixture('master-subtitles.m3u8'), {
    baseUrl: 'https://media.example.test/title/master.m3u8',
  });
  assert.deepEqual(result.subtitleTracks.map(({ language }) => language), ['es', 'en']);
  assert.equal(result.subtitleTracks[0].forced, false);
  assert.equal(result.subtitleTracks[1].forced, true);
  assert.equal(result.variants[0].subtitleGroup, 'subs');
});

test('media playlist is distinguished from a master playlist', () => {
  const result = inspectHlsManifest(readFixture('media-playlist.m3u8'));
  assert.equal(result.isHls, true);
  assert.equal(result.isMaster, false);
  assert.equal(result.isMediaPlaylist, true);
  assert.deepEqual(result.variants, []);
});

test('invalid text, empty input and non-string input fail closed', () => {
  const expected = { isHls: false, isMaster: false, isMediaPlaylist: false,
    variants: [], audioTracks: [], subtitleTracks: [] };
  assert.deepEqual(inspectHlsManifest(readFixture('invalid-not-hls.txt')), expected);
  assert.deepEqual(inspectHlsManifest(''), expected);
  assert.deepEqual(inspectHlsManifest(null), expected);
});

test('parser tolerates CRLF, spaces, unknown tags and partial metadata', () => {
  const manifest = ['\uFEFF#EXTM3U', '  #EXT-X-UNKNOWN:VALUE  ',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Latino",LANGUAGE="es-MX"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=not-known,CODECS="avc1,mp4a"',
    ' relative.m3u8 '].join('\r\n');
  const result = inspectHlsManifest(manifest);
  assert.equal(result.isMaster, true);
  assert.equal(result.audioTracks[0].language, 'es-419');
  assert.equal(result.audioTracks[0].uri, null);
  assert.equal(result.variants[0].url, 'relative.m3u8');
  assert.equal(result.variants[0].resolution, 'not-known');
  assert.equal(result.variants[0].width, null);
  assert.equal(result.variants[0].codecs, 'avc1,mp4a');
});

test('invalid or non-HTTP base URLs leave relative URIs unchanged', () => {
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8';
  assert.equal(inspectHlsManifest(manifest, { baseUrl: 'file:///tmp/master.m3u8' })
    .variants[0].url, 'video.m3u8');
  assert.equal(inspectHlsManifest(manifest, { baseUrl: 'not a URL' })
    .variants[0].url, 'video.m3u8');
});

test('a partial STREAM-INF remains inspectable without throwing', () => {
  const result = inspectHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000');
  assert.equal(result.isHls, true);
  assert.equal(result.isMaster, true);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].url, null);
});

test('inspector performs no filesystem, network, database, logging or browser work', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'streams',
    'resolverV2', 'hlsInspector.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:fs|http|https|net|dns|tls|pg)['"]\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(|puppeteer|console\./);
});
