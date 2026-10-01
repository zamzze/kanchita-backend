'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pool = require('../../config/db');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const hash = (value) =>
  crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);

const shapeOf = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return {
      scheme: url.protocol.replace(':', ''),
      host: url.hostname.toLowerCase(),
      port: url.port || null,
      pathSegments: segments.length,
      hasQuery: url.search.length > 0,
      queryKeyCount: [...url.searchParams.keys()].length,
      queryKeysHash: hash([...url.searchParams.keys()].sort().join('|')),
      pathShape: segments.map((segment) => {
        if (/^\d+$/.test(segment)) return ':num';
        if (/^[0-9a-f]{8,}$/i.test(segment)) return ':hex';
        if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) return ':token';
        if (segment.includes('.')) {
          const ext = segment.split('.').pop().toLowerCase();
          return ':file.' + ext;
        }
        return segment.length > 24 ? ':long' : segment.toLowerCase();
      }).join('/'),
    };
  } catch {
    return { invalid: true };
  }
};

const main = async () => {
  const { rows } = await pool.query(
    `SELECT
       scs.iframe_url,
       scs.iframe_host,
       scs.server_index,
       sci.provider_id,
       sci.mapped_content_id,
       sci.tmdb_id
     FROM source_catalog_servers scs
     JOIN source_catalog_items sci ON sci.id = scs.catalog_item_id
     WHERE scs.is_active = TRUE
       AND sci.fetch_status = 'ok'
       AND sci.match_status = 'matched'
       AND sci.mapped_content_type = 'movie'
       AND sci.mapped_content_id IS NOT NULL`
  );

  const byHost = new Map();
  const byShape = new Map();
  const byServerIndex = new Map();
  const invalid = [];

  for (const row of rows) {
    const shape = shapeOf(row.iframe_url);
    if (shape.invalid) {
      invalid.push(hash(row.iframe_url));
      continue;
    }

    byHost.set(shape.host, (byHost.get(shape.host) || 0) + 1);
    byServerIndex.set(
      Number(row.server_index),
      (byServerIndex.get(Number(row.server_index)) || 0) + 1
    );

    const key = JSON.stringify({
      host: shape.host,
      scheme: shape.scheme,
      pathSegments: shape.pathSegments,
      hasQuery: shape.hasQuery,
      queryKeyCount: shape.queryKeyCount,
      queryKeysHash: shape.queryKeysHash,
      pathShape: shape.pathShape,
    });
    byShape.set(key, (byShape.get(key) || 0) + 1);
  }

  const hostCounts = [...byHost.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);

  const shapeCounts = [...byShape.entries()]
    .map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((a, b) => b.count - a.count);

  const serverIndexCounts = [...byServerIndex.entries()]
    .map(([serverIndex, count]) => ({ serverIndex, count }))
    .sort((a, b) => a.serverIndex - b.serverIndex);

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_SOURCE_SHAPE_AUDIT',
    privacy: {
      rawUrlsStored: false,
      requestsToIframeDestinations: false,
      databaseWrites: false,
      queryKeysStoredInPlaintext: false,
    },
    population: {
      activeMappedServers: rows.length,
      distinctHosts: hostCounts.length,
      distinctUrlShapes: shapeCounts.length,
      invalidUrls: invalid.length,
    },
    hosts: hostCounts,
    serverIndexes: serverIndexCounts,
    urlShapes: shapeCounts.slice(0, 50),
    recommendation:
      hostCounts.length === 1 && shapeCounts.length <= 5
        ? 'SINGLE_HOST_FEW_SHAPES_GOOD_RESOLVER_TARGET'
        : 'MULTI_SHAPE_RESOLVER_ADAPTERS_RECOMMENDED',
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-source-shape-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialSourceShapeAudit] Complete');
  console.log('  active mapped servers : ' + rows.length);
  console.log('  distinct hosts        : ' + hostCounts.length);
  console.log('  distinct URL shapes   : ' + shapeCounts.length);
  console.log('  invalid URLs          : ' + invalid.length);
  console.log('  recommendation        : ' + summary.recommendation);
  console.log('  summary               : ' + output);
};

main()
  .catch((error) => {
    console.error('[TutorialSourceShapeAudit] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
