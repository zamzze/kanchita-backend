'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { createSafeHttpClient } = require('../../modules/streams/http/safeHttpClient');
const { extractLinks } = require('../../modules/streams/resolverV2/html/staticHtmlExtractor');
const { createDirectHlsResolver } = require('../../modules/streams/resolverV2/resolvers/directHlsResolver');
const { createDirectMp4Resolver } = require('../../modules/streams/resolverV2/resolvers/directMp4Resolver');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');
const TARGET_HOST = 'nupload.my';

const contentTypeEssence = (value) =>
  String(value || '').split(';', 1)[0].trim().toLowerCase();

const describeUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return {
      scheme: url.protocol.slice(0, -1),
      host: url.hostname.toLowerCase(),
      pathShape: segments.map((segment) => {
        if (/^\d+$/.test(segment)) return ':num';
        if (/^[0-9a-f]{8,}$/i.test(segment)) return ':hex';
        if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) return ':token';
        if (segment.includes('.')) return ':file.' + segment.split('.').pop().toLowerCase();
        return segment.length > 24 ? ':long' : segment.toLowerCase();
      }).join('/'),
      hasQuery: url.search.length > 0,
      queryKeyCount: [...url.searchParams.keys()].length,
    };
  } catch {
    return { invalid: true };
  }
};

const safeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'CANARY_ERROR',
});

const loadSample = async (shape) => {
  const prefix = shape === 'watch_token'
    ? 'https://nupload.my/watch/%'
    : 'https://nupload.my/iframe%';

  const { rows } = await pool.query(
    `SELECT
       scs.iframe_url,
       scs.server_index,
       sci.tutorial_url,
       sci.mapped_content_id,
       sci.tmdb_id
     FROM source_catalog_servers scs
     JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id
     WHERE scs.is_active = TRUE
       AND sci.fetch_status = 'ok'
       AND sci.match_status = 'matched'
       AND sci.mapped_content_type = 'movie'
       AND sci.mapped_content_id IS NOT NULL
       AND scs.iframe_host = $1
       AND scs.iframe_url LIKE $2
     ORDER BY scs.id ASC
     LIMIT 100`,
    [TARGET_HOST, prefix]
  );

  for (const row of rows) {
    try {
      const url = new URL(row.iframe_url);
      const pathname = url.pathname.replace(/\/+$/, '');
      if (shape === 'watch_token' &&
          pathname.startsWith('/watch/') &&
          url.search.length === 0) {
        return row;
      }
      if (shape === 'iframe_query' &&
          pathname === '/iframe' &&
          url.search.length > 0) {
        return row;
      }
    } catch {
      // Ignore malformed rows; source-shape audit already counts them separately.
    }
  }

  return null;
};

const probeDirect = async (candidate, hlsResolver, mp4Resolver) => {
  const result = { hlsStreams: 0, mp4Streams: 0, errors: [] };
  try {
    result.hlsStreams = (await hlsResolver.resolve(candidate)).length;
  } catch (error) {
    result.errors.push({ resolver: 'direct_hls', ...safeError(error) });
  }
  if (result.hlsStreams === 0) {
    try {
      result.mp4Streams = (await mp4Resolver.resolve(candidate)).length;
    } catch (error) {
      result.errors.push({ resolver: 'direct_mp4', ...safeError(error) });
    }
  }
  return result;
};

const summarizeLinks = (links) => {
  const counts = new Map();
  for (const link of links) {
    const description = describeUrl(link.url);
    const key = JSON.stringify({ kind: link.kind, ...description });
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((a, b) => b.count - a.count);
};

const probeSample = async (shape, row, http, hlsResolver, mp4Resolver) => {
  if (!row) return { shape, found: false, recommendation: 'SOURCE_SHAPE_NOT_FOUND' };

  const candidate = {
    providerId: 'tutorial_catalog',
    url: row.iframe_url,
    referer: row.tutorial_url,
    headers: {},
    metadata: { canaryShape: shape },
  };

  const direct = await probeDirect(candidate, hlsResolver, mp4Resolver);
  const output = {
    shape,
    found: true,
    serverIndex: Number(row.server_index),
    source: describeUrl(row.iframe_url),
    direct,
    html: null,
    extractedLinkShapes: [],
    extractedDirect: { tested: 0, hlsStreams: 0, mp4Streams: 0, errors: [] },
    recommendation: null,
  };

  if (direct.hlsStreams > 0) {
    output.recommendation = 'DIRECT_HLS_AVAILABLE';
    return output;
  }
  if (direct.mp4Streams > 0) {
    output.recommendation = 'DIRECT_MP4_AVAILABLE';
    return output;
  }

  let response;
  try {
    response = await http.get(row.iframe_url, {
      headers: {
        referer: row.tutorial_url,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: 6000,
      maxBytes: 512 * 1024,
      maxRedirects: 3,
    });
  } catch (error) {
    output.html = { error: safeError(error) };
    output.recommendation = 'CANARY_NETWORK_REVIEW_REQUIRED';
    return output;
  }

  const type = contentTypeEssence(response.headers?.['content-type']);
  output.html = {
    ok: response.ok,
    status: response.status,
    contentType: type || null,
    bytes: response.body?.length || 0,
    redirects: response.redirects,
    finalUrl: describeUrl(response.url),
  };

  if (!response.ok) {
    output.recommendation = [401, 403].includes(response.status)
      ? 'SOURCE_REQUIRES_UNSUPPORTED_ACCESS_SEMANTICS'
      : 'SOURCE_HTTP_FAILURE';
    return output;
  }

  if (!['text/html', 'application/xhtml+xml'].includes(type)) {
    output.recommendation = 'NON_HTML_NON_DIRECT_RESPONSE_REVIEW_REQUIRED';
    return output;
  }

  const links = extractLinks(response.body.toString('utf8'), {
    baseUrl: response.url,
    selectors: ['iframe.src', 'source.src', 'video.src'],
    maxLinks: 16,
  });
  output.extractedLinkShapes = summarizeLinks(links);

  const directLinks = links.filter((link) =>
    link.kind === 'source' || link.kind === 'video' ||
    /\.(?:m3u8|mp4)(?:$|[?#])/i.test(link.url)
  ).slice(0, 4);

  for (const link of directLinks) {
    output.extractedDirect.tested += 1;
    const probe = await probeDirect({
      providerId: 'tutorial_catalog',
      url: link.url,
      referer: response.url,
      headers: {},
      metadata: { canaryShape: shape, discoveredKind: link.kind },
    }, hlsResolver, mp4Resolver);
    output.extractedDirect.hlsStreams += probe.hlsStreams;
    output.extractedDirect.mp4Streams += probe.mp4Streams;
    output.extractedDirect.errors.push(...probe.errors);
  }

  if (output.extractedDirect.hlsStreams > 0) {
    output.recommendation = 'STATIC_HTML_TO_HLS_VIABLE';
  } else if (output.extractedDirect.mp4Streams > 0) {
    output.recommendation = 'STATIC_HTML_TO_MP4_VIABLE';
  } else if (links.some((link) => link.kind === 'iframe')) {
    output.recommendation = 'NESTED_HTML_RESOLUTION_NEEDED';
  } else if (links.length > 0) {
    output.recommendation = 'STATIC_HTML_LINKS_FOUND_NO_DIRECT_MEDIA';
  } else {
    output.recommendation = 'WORKFLOW_OR_TEXT_EXTRACTION_NEEDED';
  }

  return output;
};

const main = async () => {
  const [watch, iframe] = await Promise.all([
    loadSample('watch_token'),
    loadSample('iframe_query'),
  ]);

  const http = createSafeHttpClient({
    timeoutMs: 6000,
    maxBytes: 512 * 1024,
    maxRedirects: 3,
  });
  const hlsResolver = createDirectHlsResolver({
    httpClient: http,
    timeoutMs: 6000,
    maxManifestBytes: 256 * 1024,
  });
  const mp4Resolver = createDirectMp4Resolver({
    httpClient: http,
    timeoutMs: 6000,
  });

  const samples = [];
  samples.push(await probeSample('watch_token', watch, http, hlsResolver, mp4Resolver));
  samples.push(await probeSample('iframe_query', iframe, http, hlsResolver, mp4Resolver));

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_NUPLOAD_RESOLVER_V2_CANARY',
    safety: {
      databaseWrites: false,
      browserAutomation: false,
      cookiesOrAuthentication: false,
      antiBotBypass: false,
      rawUrlsStored: false,
      maxSourceSamples: 2,
      maxExtractedDirectProbesPerSample: 4,
    },
    samples,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-nupload-resolver-v2-canary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[NuploadResolverV2Canary] Complete');
  for (const sample of samples) {
    console.log(
      '  ' + sample.shape +
      ' | recommendation=' + sample.recommendation +
      ' | hls=' + (sample.direct?.hlsStreams || sample.extractedDirect?.hlsStreams || 0) +
      ' | mp4=' + (sample.direct?.mp4Streams || sample.extractedDirect?.mp4Streams || 0)
    );
  }
  console.log('  summary: ' + output);
};

main()
  .catch((error) => {
    console.error('[NuploadResolverV2Canary] ' + (error?.code || error.message));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
