'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  detectChannelSignals,
  deriveChannelPattern,
  scanTopLevelChannelCoverageV2,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiChannelCoverageV2');
const {
  formatKodiChannelCoverageV2Json,
  formatKodiChannelCoverageV2Text,
  formatKodiTaxonomyJson,
  parseKodiTaxonomyArgs,
} = require('../src/modules/streams/resolverV2/diagnostics/kodiTaxonomyCli');

const withChannels = (files, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanchita-channel-coverage-'));
  const channels = path.join(root, 'channels');
  fs.mkdirSync(channels);
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(channels, name), source);
  }
  return Promise.resolve(callback(root, channels)).finally(() =>
    fs.rmSync(root, { recursive: true, force: true }));
};

test('channel coverage flag is independent, opt-in and single-root only', () => {
  const root = ['--balandro-path', 'C:/fixtures/balandro'];
  assert.deepEqual(parseKodiTaxonomyArgs([...root, '--channel-coverage-v2', '--json']), {
    ok: true, json: true, coverage: false, channelCoverageV2: true,
    roots: ['C:/fixtures/balandro'],
  });
  assert.equal(parseKodiTaxonomyArgs([...root, '--channel-coverage-v2', '--architecture']).ok,
    false);
  assert.equal(parseKodiTaxonomyArgs([...root, '--channel-coverage-v2',
    '--alfa-path', 'C:/fixtures/alfa']).ok, false);
});

test('JSON API and HTML catalogs are mappable with current primitives', async () => {
  await withChannels({
    '__init__.py': '',
    'api.py': `page=httptools.downloadpage(url); data=json.loads(page.data); item_id=data['id']`,
    'html.py': `page=httptools.downloadpage(url); items=scrapertools.find_single_match(page.data, pattern); iframe=items`,
  }, (root) => {
    const result = scanTopLevelChannelCoverageV2({ root });
    assert.deepEqual(result.channels.map(({ channel, pattern, assessment }) =>
      [channel, pattern, assessment]), [
      ['api', 'JSON_API_CATALOG', 'MAPPABLE_WITH_CURRENT_COMPONENTS'],
      ['html', 'HTML_CATALOG', 'MAPPABLE_WITH_CURRENT_COMPONENTS'],
    ]);
  });
});

test('HTML AJAX episodes and multi-step HTTP workflows are detected', async () => {
  await withChannels({
    'ajax.py': `page=httptools.downloadpage(url); html=scrapertools.get_match(page.data,p)
      temporada=1; episodio=2; ajax='/ajax'; player=httptools.downloadpage(ajax, post={'id':item_id})`,
    'steps.py': `one=httptools.downloadpage(url); two=httptools.downloadpage(next_url)
      iframe=two.data; servertools.find_video_items(iframe)`,
  }, (root) => {
    const result = scanTopLevelChannelCoverageV2({ root });
    assert.equal(result.channels[0].pattern, 'HTML_AJAX_WORKFLOW');
    assert.equal(result.channels[1].pattern, 'MULTI_STEP_HTTP_WORKFLOW');
    assert.ok(result.channels.every(({ assessment }) =>
      assessment === 'MAPPABLE_WITH_CURRENT_COMPONENTS'));
  });
});

test('server delegation is channel output and never a final-resolution blocker', () => {
  const signals = detectChannelSignals(`page=httptools.downloadpage(url)
    html=scrapertools.get_match(page.data, pattern)
    iframe=html; servertools.resolve_video_urls(iframe)`);
  assert.ok(signals.sourceSignals.includes('server_delegation'));
  assert.equal(signals.blockerSignals.includes('server_delegation'), false);
  assert.equal(deriveChannelPattern(signals), 'HTML_CATALOG');
});

test('JavaScript, session and anti-bot signals map to explicit unsupported states', async () => {
  await withChannels({
    'javascript.py': `page=httptools.downloadpage(url); value=jsunpack(page.data)`,
    'session.py': `session=requests.Session(); page=session.get(url); cookiejar=session.cookies`,
    'browser.py': `page=httptools.downloadpage(url); cloudflare='captcha'`,
  }, (root) => {
    const byId = Object.fromEntries(scanTopLevelChannelCoverageV2({ root }).channels
      .map((item) => [item.channel, item]));
    assert.equal(byId.javascript.assessment, 'UNSUPPORTED_JAVASCRIPT');
    assert.equal(byId.session.assessment, 'UNSUPPORTED_SESSION');
    assert.equal(byId.browser.assessment, 'UNSUPPORTED_BROWSER');
  });
});

test('unknown input stays unknown and bounded generic gaps are exact', async () => {
  await withChannels({
    'unknown.py': 'CONSTANT = 1',
    'regex.py': `page=httptools.downloadpage(url)
      a=re.findall(one,page.data); b=re.search(two,page.data); c=re.sub(three,'',page.data)
      iframe=a[0]`,
    'mp4.py': `page=httptools.downloadpage(url); media='video.mp4'`,
    'proxy.py': `proxy='regional'; page=httptools.downloadpage(url)
      html=scrapertools.get_match(page.data, pattern); iframe=html`,
  }, (root) => {
    const byId = Object.fromEntries(scanTopLevelChannelCoverageV2({ root }).channels
      .map((item) => [item.channel, item]));
    assert.equal(byId.unknown.assessment, 'UNKNOWN');
    assert.deepEqual(byId.regex.missingCapabilities, ['html_regex_transform']);
    assert.deepEqual(byId.mp4.missingCapabilities, ['direct_mp4']);
    assert.deepEqual(byId.proxy.missingCapabilities, ['proxy_or_geo']);
    assert.equal(byId.regex.assessment, 'NEEDS_SMALL_GENERIC_COMPONENT');
    assert.equal(byId.proxy.assessment, 'NEEDS_SMALL_GENERIC_COMPONENT');
  });
});

test('population counts exactly 54 top-level files and separates empty init', async () => {
  const files = { '__init__.py': '' };
  for (let index = 1; index <= 53; index += 1) {
    files[`channel_${String(index).padStart(2, '0')}.py`] =
      'page=httptools.downloadpage(url); html=scrapertools.get_match(page.data,p)';
  }
  await withChannels(files, (root, channels) => {
    const nested = path.join(channels, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'ignored.py'), 'javascript eval(payload)');
    const result = scanTopLevelChannelCoverageV2({ root });
    assert.deepEqual(result.population,
      { topLevelFiles: 54, channels: 53, emptyInitFiles: 1 });
    assert.equal(result.channels.some(({ channel }) => channel === 'ignored'), false);
  });
});

test('channel ordering and JSON output are deterministic and redact source content', async () => {
  await withChannels({
    'zeta.py': `page=httptools.downloadpage('https://private.example/?token=SECRET')`,
    'alpha.py': 'CONSTANT=1',
  }, (root) => {
    const first = scanTopLevelChannelCoverageV2({ root });
    const second = scanTopLevelChannelCoverageV2({ root });
    assert.deepEqual(first, second);
    assert.deepEqual(first.channels.map(({ channel }) => channel), ['alpha', 'zeta']);
    const json = formatKodiChannelCoverageV2Json(first);
    assert.deepEqual(JSON.parse(json).channelCoverageV2, first);
    assert.doesNotMatch(json, /private\.example|SECRET|https?:\/\//i);
    assert.doesNotMatch(formatKodiChannelCoverageV2Text(first),
      /private\.example|SECRET|https?:\/\//i);
  });
});

test('old CLI formatting remains unchanged without the new flag', () => {
  const taxonomy = { servers: { total: 0, active: 0 }, channels: { total: 0 },
    skipped: 0, records: [] };
  assert.equal(formatKodiTaxonomyJson(taxonomy), JSON.stringify(taxonomy));
  assert.deepEqual(parseKodiTaxonomyArgs(['--balandro-path', 'C:/fixture']), {
    ok: true, json: false, coverage: false, roots: ['C:/fixture'],
  });
});

test('channel coverage implementation is static, bounded and has no execution or network imports', () => {
  const source = fs.readFileSync(require.resolve(
    '../src/modules/streams/resolverV2/diagnostics/kodiChannelCoverageV2'), 'utf8');
  assert.doesNotMatch(source,
    /node:(?:http|https|child_process|vm)|\bfetch\s*\(|axios|dynamic\s+import|new Function|\beval\s*\(/i);
});
