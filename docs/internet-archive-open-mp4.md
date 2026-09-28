# Internet Archive open-license MP4 source

The opt-in catalog example is `config/resolver-v2/internet-archive-open.catalog.json`.
It contains no item IDs and is disabled by default. An active
`provider_media_mappings` row must map a known movie TMDB ID to the exact
Internet Archive identifier (`external_id`); neither playback nor this provider
searches the Archive catalog or matches titles. The mapping is the stable
identity. Do not add one without checking the individual item's rights.
Enabling it also requires an appropriately bounded Primary deadline: the
current default is five seconds, while Archive metadata plus redirect validation
may need longer (up to the configured 15-second Primary limit).

The mapped source makes one bounded `GET /metadata/{identifier}` request via
SafeHttpClient. It requires matching identifier, `mediatype=movies`, and an
explicit CC BY, CC BY-SA (3.0/4.0) or CC0 license URL. It rejects missing or
unknown rights and dark/restricted items. From at most 128 file records it
selects up to eight MP4 files deterministically by declared dimensions,
original/derivative status, size and filename; preview/trailer/thumbnail files
are excluded. The canonical `https://archive.org/download/{identifier}/{filename}`
URL becomes the candidate identity. File dimensions provide a quality hint
only for known exact heights; audio language is not inferred.

DirectMp4Resolver validates the candidate with bounded HEAD and a 64-byte
Range GET through the SSRF-safe client, including redirect validation. Its
StreamCandidate retains the canonical input URL, never the redirected CDN URL.
Primary accepts validated, headerless MP4; the existing stream lifecycle
stores `stream_type=mp4`, gives it the configured TTL when no expiry is
declared, and revalidates it after the verification interval. The API returns
the direct MP4 URL; this does not proxy or transcode video. Playback depends on
the client/player supporting direct MP4 and normal browser CORS behavior.

`BigBuckBunny_328` was a one-item diagnostic, not a production mapping.
Archive metadata declares CC BY 3.0 US for that item, independently supported
by the Blender project's own CC BY 3.0 statement. Its selected file is
`BigBuckBunny_512kb.mp4` (240p). This proves the plumbing, not HD coverage,
catalog-scale matching, region availability, or that other Archive items are
licensed. Bulk mapping needs a separate rights-aware discovery/review process.

Run `npm run test:archive-open` with `TEST_DB_URL` pointing to an isolated
PostgreSQL 15 test database for the DB integration; never point it at
`streaming_db`. The test uses a random schema, applies all migrations, and
removes only that schema. Offline tests use a local fixture and explicitly
allow private network access only within the fixture client.
