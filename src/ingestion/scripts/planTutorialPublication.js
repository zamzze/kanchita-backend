'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');

const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const main = async () => {
  const { rows } = await pool.query(
    `WITH catalog AS (
       SELECT
         sci.mapped_content_id AS movie_id,
         COUNT(DISTINCT sci.id)::int AS catalog_items,
         COUNT(scs.id) FILTER (WHERE scs.is_active = TRUE)::int AS active_catalog_servers
       FROM source_catalog_items sci
       LEFT JOIN source_catalog_servers scs
         ON scs.catalog_item_id = sci.id
       WHERE sci.match_status = 'matched'
         AND sci.mapped_content_type = 'movie'
         AND sci.mapped_content_id IS NOT NULL
       GROUP BY sci.mapped_content_id
     ),
     ready_streams AS (
       SELECT
         content_id AS movie_id,
         COUNT(*) FILTER (
           WHERE is_active = TRUE
             AND status = 'ready'
             AND stream_type = 'direct'
             AND stream_url IS NOT NULL
             AND (expires_at IS NULL OR expires_at > NOW())
         )::int AS ready_direct_streams
       FROM streams
       WHERE content_type = 'movie'
       GROUP BY content_id
     )
     SELECT
       m.id,
       m.is_published,
       m.tmdb_id,
       (m.title IS NOT NULL AND BTRIM(m.title) <> '') AS has_title,
       (m.poster_url IS NOT NULL AND BTRIM(m.poster_url) <> '') AS has_poster,
       (m.backdrop_url IS NOT NULL AND BTRIM(m.backdrop_url) <> '') AS has_backdrop,
       (m.release_year IS NOT NULL) AS has_year,
       COALESCE(c.catalog_items, 0) AS catalog_items,
       COALESCE(c.active_catalog_servers, 0) AS active_catalog_servers,
       COALESCE(rs.ready_direct_streams, 0) AS ready_direct_streams
     FROM movies m
     JOIN catalog c ON c.movie_id = m.id
     LEFT JOIN ready_streams rs ON rs.movie_id = m.id`
  );

  const counts = {
    mappedMovies: rows.length,
    currentlyPublished: 0,
    currentlyUnpublished: 0,
    metadataCoreReady: 0,
    withCatalogCandidates: 0,
    withReadyDirectStream: 0,
    unpublishedWithReadyDirectStream: 0,
    unpublishedMetadataReadyButNoDirectStream: 0,
    missingPoster: 0,
    missingBackdrop: 0,
    missingYear: 0,
  };

  for (const row of rows) {
    if (row.is_published) counts.currentlyPublished += 1;
    else counts.currentlyUnpublished += 1;

    const metadataReady =
      row.has_title === true &&
      row.has_poster === true &&
      row.has_year === true;

    if (metadataReady) counts.metadataCoreReady += 1;
    if (Number(row.active_catalog_servers) > 0) counts.withCatalogCandidates += 1;
    if (Number(row.ready_direct_streams) > 0) counts.withReadyDirectStream += 1;

    if (!row.is_published && Number(row.ready_direct_streams) > 0) {
      counts.unpublishedWithReadyDirectStream += 1;
    }

    if (!row.is_published && metadataReady && Number(row.ready_direct_streams) === 0) {
      counts.unpublishedMetadataReadyButNoDirectStream += 1;
    }

    if (!row.has_poster) counts.missingPoster += 1;
    if (!row.has_backdrop) counts.missingBackdrop += 1;
    if (!row.has_year) counts.missingYear += 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_PUBLICATION_PLAN',
    databaseWrites: false,
    policy: {
      catalogCandidateAloneIsNotPlaybackReady: true,
      publishGate: 'READY_DIRECT_STREAM_REQUIRED_FOR_NEW_MOVIES',
    },
    counts,
    recommendation:
      counts.unpublishedWithReadyDirectStream > 0
        ? 'SOME_UNPUBLISHED_MOVIES_HAVE_VALIDATED_PLAYBACK'
        : 'DO_NOT_BULK_PUBLISH_UNTIL_CATALOG_RESOLVER_PRODUCES_READY_STREAMS',
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const output = path.join(REPORT_DIR, 'tutorial-publication-plan-summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');

  console.log('[TutorialPublicationPlan] Complete');
  console.log('  mapped movies                         : ' + counts.mappedMovies);
  console.log('  unpublished                           : ' + counts.currentlyUnpublished);
  console.log('  metadata core ready                   : ' + counts.metadataCoreReady);
  console.log('  with catalog candidates               : ' + counts.withCatalogCandidates);
  console.log('  with ready direct stream              : ' + counts.withReadyDirectStream);
  console.log('  unpublished + ready direct stream     : ' + counts.unpublishedWithReadyDirectStream);
  console.log('  unpublished metadata-ready/no stream  : ' + counts.unpublishedMetadataReadyButNoDirectStream);
  console.log('  recommendation                        : ' + summary.recommendation);
  console.log('  summary                               : ' + output);
};

main()
  .catch((error) => {
    console.error('[TutorialPublicationPlan] ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
