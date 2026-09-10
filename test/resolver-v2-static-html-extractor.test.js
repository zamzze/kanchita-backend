'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractLinks, decodeEntities, normalizeSelectors } =
  require('../src/modules/streams/resolverV2/html/staticHtmlExtractor');
const { normalizeMediaPathTemplate, renderMediaPath } =
  require('../src/modules/streams/resolverV2/html/mediaPathTemplate');

test('extracts only selected static attributes across common HTML syntax', () => {
  const html = `<IFRAME data-x=1 SRC="/one?x=1&amp;y=2#fragment"></IFRAME>
    <source src='//media.example.test/two'><video SRC=/three></video>
    <a href="/four">four</a><script>const x='<iframe src="/evil">'</script>
    <style>x{content:'<video src=/evil2>'}</style><!-- <iframe src=/evil3> -->`;
  assert.deepEqual(extractLinks(html, { baseUrl: 'https://source.example.test/base',
    selectors: ['iframe.src', 'source.src', 'video.src'] }), [
    { url: 'https://source.example.test/one?x=1&y=2', kind: 'iframe' },
    { url: 'https://media.example.test/two', kind: 'source' },
    { url: 'https://source.example.test/three', kind: 'video' },
  ]);
  assert.deepEqual(extractLinks(html, { baseUrl: 'https://source.example.test',
    selectors: ['a.href'] }), [{ url: 'https://source.example.test/four', kind: 'anchor' }]);
});

test('entities, schemes, credentials, dedupe and bounds are handled safely', () => {
  assert.equal(decodeEntities('&quot;&#65;&#x42;&apos;&lt;&gt;'), '"AB\'<>');
  const html = `<video src=/same#one><video src=/same#two>
    <video src="javascript:x"><video src="data:x"><video src="file:///x">
    <video src="ftp://example.test/x"><video src="https://u:p@example.test/x">
    <video src=/second>`;
  assert.deepEqual(extractLinks(html, { baseUrl: 'https://source.example.test',
    selectors: ['video.src'], maxLinks: 1 }), [
    { url: 'https://source.example.test/same', kind: 'video' },
  ]);
  assert.deepEqual(extractLinks('<broken> <video\tSRC=/ok> tail', {
    baseUrl: 'https://source.example.test', selectors: ['video.src'] }),
  [{ url: 'https://source.example.test/ok', kind: 'video' }]);
});

test('invalid extractor configuration fails closed', () => {
  assert.equal(normalizeSelectors(['script.src']), null);
  assert.deepEqual(extractLinks('<video src=/x>', { baseUrl: 'bad',
    selectors: ['video.src'] }), []);
  assert.deepEqual(extractLinks('<video src=/x>', { baseUrl: 'https://a.test',
    selectors: ['bad'], maxLinks: 32 }), []);
  assert.deepEqual(extractLinks('<video src=/x>', { baseUrl: 'https://a.test',
    selectors: ['video.src'], maxLinks: 65 }), []);
});

test('media path templates permit numeric identity only and preserve origin', () => {
  const movie = { tmdbId: 550 };
  const episode = { tmdbId: 10, season: 0, episode: 2 };
  assert.equal(renderMediaPath('/movie/{tmdbId}', movie, 'https://source.example.test/base'),
    'https://source.example.test/movie/550');
  assert.equal(renderMediaPath('/show/{tmdbId}/{season}/{episode}', episode,
    'https://source.example.test'), 'https://source.example.test/show/10/0/2');
  for (const value of ['/x/{title}', '/../x', '/%2e%2e/x', '//evil.test/x',
    '/x\\y', '/x\0y', 'https://evil.test/x']) assert.equal(normalizeMediaPathTemplate(value), null);
  assert.equal(renderMediaPath('/show/{season}', {}, 'https://source.example.test'), null);
});
