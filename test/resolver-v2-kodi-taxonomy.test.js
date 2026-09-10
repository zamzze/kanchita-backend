'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyText, scanKodiTaxonomy } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner');
const { parseKodiTaxonomyArgs, formatKodiTaxonomyJson, formatKodiTaxonomyText } =
  require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

test('taxonomy rules classify architectural capabilities without execution', () => {
  const source = `requests.get('https://private.example/x?token=SECRET')
    json.loads(data); iframe; headers={'Referer':'x'}; cookiejar;
    jsunpack(data); selenium; cloudflare captcha; widevine drm; video.m3u8`;
  const result = classifyText(source);
  for (const expected of ['direct_hls', 'direct_http', 'json_api', 'iframe_http',
    'header_bound', 'cookie_session', 'javascript_transform', 'browser_required',
    'anti_bot', 'drm_or_protected']) assert.ok(result.classifications.includes(expected));
  assert.equal(classifyText('plain harmless module').classifications[0], 'unknown');
});

test('scanner reads bounded server/channel text and emits redacted taxonomy only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-taxonomy-'));
  const servers = path.join(root, 'plugin.video.alfa', 'servers');
  const channels = path.join(root, 'plugin.video.alfa', 'channels');
  fs.mkdirSync(servers, { recursive: true }); fs.mkdirSync(channels, { recursive: true });
  fs.writeFileSync(path.join(servers, 'server_one.py'),
    `os.system('NEVER'); subprocess.run('NEVER'); eval('NEVER'); url='https://private.example/a?token=SECRET'; parse_hls(url); headers={'Cookie':'SECRET'}`);
  fs.writeFileSync(path.join(servers, 'inactive.json'),
    JSON.stringify({ active: false, find_videos: [{ url: 'https://secret.example' }] }));
  fs.writeFileSync(path.join(channels, 'movies.py'),
    'def search(): pass\nresponse.json()\nservertools.find_video_items()');
  fs.writeFileSync(path.join(servers, 'binary.py'), Buffer.from([0, 1, 2]));
  try {
    const result = scanKodiTaxonomy({ roots: [root] });
    assert.equal(result.servers.total, 2);
    assert.equal(result.servers.active, 1);
    assert.ok(result.servers.direct_hls >= 1);
    assert.equal(result.channels.total, 1);
    assert.ok(result.skipped >= 1);
    for (const output of [formatKodiTaxonomyJson(result), formatKodiTaxonomyText(result)]) {
      assert.doesNotMatch(output,
        /private\.example|secret\.example|token=SECRET|Authorization: SECRET|Cookie: SECRET|os\.system|subprocess\.run|eval\(/i);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('taxonomy CLI accepts local paths only and modules have no execution/network primitives', () => {
  assert.equal(parseKodiTaxonomyArgs(['--alfa-path', 'C:/tmp/alfa']).ok, true);
  assert.equal(parseKodiTaxonomyArgs(['--balandro-path', 'C:/tmp/b', '--json']).ok, true);
  for (const args of [[], ['--url', 'https://x'], ['--output', 'x'],
    ['--alfa-path'], ['--alfa-path', 'a', '--alfa-path', 'b']]) {
    assert.equal(parseKodiTaxonomyArgs(args).ok, false);
  }
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyScanner'), 'utf8');
  assert.doesNotMatch(source,
    /require\(['"]node:(?:http|https|child_process|vm)['"]\)|\bspawn\s*\(|\bexec\s*\(|new Function|\beval\s*\(/i);
});
