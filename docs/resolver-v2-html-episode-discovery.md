# HTML episode hierarchy: mapping before playback

`HTML_EMBED_LEAF` remains a five-step playback workflow: request the exact
episode path, extract structured source attributes, decode Base64 per row,
filter HTTPS, and emit candidates. It does not visit series or season pages.

The ingestion-only `createHtmlEpisodeMappingDiscovery` takes a known series
TMDB identity and a provider series ID. It reads one series page and at most
16 same-origin season pages through the injected SafeHttpClient. Structured
`data-season`, `data-episode`, and `data-href` attributes yield exact
`episode` mappings through the existing Mapping Factory contract. Identical
links are deduplicated; conflicting links for the same number are discarded.
The caller persists results with the existing provider media mapping store.

Each mapping stores the series TMDB ID, season number, episode number, and a
canonical same-origin episode path as `external_id`. It stores neither a
playback URL nor a title-derived match. Discovery defaults to eight seasons
and 32 episodes per season, with hard limits of 16 and 64 respectively; each
HTML response is capped at 256 KiB, redirects are disabled, and one global
deadline covers the run. A hierarchy exceeding a limit fails closed.

The existing `ingest:mappings` command runs this discovery manually or in a
bounded batch. It requires a local JSON configuration with `id`, `region`,
`baseUrl`, and `seriesPathTemplate` (optional `maxSeasons`,
`maxEpisodesPerSeason`, `timeoutMs`). A matching **active series mapping**
must already identify the provider's series root. No site is built in or
enabled by default.

```text
npm run ingest:mappings -- --html-episode-config local-provider.json --series-tmdb-id 900
npm run ingest:mappings -- --html-episode-config local-provider.json --limit 10
npm run ingest:mappings -- --resume RUN_UUID --html-episode-config local-provider.json
```

The command reuses `provider_mapping` runs/items, `SKIP LOCKED` claims,
failure requeue on resume, and `provider_media_mappings.upsertMapping`.
The `--limit` selection is ordered by TMDB ID. Progress counts series items;
the final inserted/updated/unchanged/failed counts describe episode mappings
processed in that invocation. A failed item can be retried without creating
duplicate episode mappings. The command is not a scheduler, and the local
config is not a provider catalog entry.

Resolver V2 still accepts only `movie` and `episode` MediaContext values, and
the playback workflow DSL still has an eight-step maximum.
