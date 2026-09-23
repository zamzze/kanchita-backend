# Bulk ingestion: persistence foundation

`movies / series / episodes → provider_media_mappings → provider_sources → resolved_stream_cache → ingestion_runs → ingestion_run_items`

The existing `movies`, `series` and `episodes` tables remain the catalog. Movie and series TMDB IDs are unique; episodes are unique by series, season and episode. `provider_media_mappings` (migration 009) remains the provider identity store, including region, external ID, status and verification time. No second catalog or mapping table is introduced.

Migration 010 adds a separate ingestion ledger:

- `provider_sources` stores relatively stable HTTP(S) embed/API/direct-media locations. Identity is `(mapping_id, SHA-256(source_type, canonical source_url, resolver_id, language, quality))`. A repeated upsert updates the same row. Signed/secret-query source URLs and sensitive headers/metadata are rejected by the store.
- `resolved_stream_cache` stores resolved URLs by `(source_id, SHA-256(protocol, quality, language, variant_key))`. Rotation replaces the URL in that slot; another `variant_key` permits a parallel variant. A temporary signed URL requires `expires_at` and is cleared on non-active/failure transitions. A cache hit requires an active source/stream, `validated_at` within 30 minutes and expiry beyond a 60-second safety window. Stored alone never means playable. This table is not wired to the existing playback `streams` table yet.
- `ingestion_runs` stores run status, bounded JSON checkpoint/config and counters. Counters are reconciled from terminal run items, so repeating reconciliation is idempotent. The checkpoint is operational progress, not a provider response or credential store.
- `ingestion_run_items` uses exactly one FK to `movies` or `episodes`; unique partial indexes on `(run_id, movie_id)` and `(run_id, episode_id)` prevent duplicates. A failed item can be upserted back to `pending` without changing identity. `series` itself is catalog metadata; ingestion work items are movie/episode playback identities.

`resumeRun` transactionally locks a pending/paused/failed run, requeues abandoned `processing` items, reconciles counters and marks it running. `claimNextPendingItems` uses a short transaction, a run-status lock and `FOR UPDATE SKIP LOCKED`; concurrent claimers receive different items. No network activity or worker is added. Checkpoints are updated through `updateCounters`, and callers must reconcile after recording item outcomes. No transaction stays open during future remote resolution.

Catalog and mapping identities are durable. Sources are refreshable. Resolved URLs are ephemeral and must be revalidated or rotated; the pre-existing `streams` table remains authoritative for current playback. Error fields accept stable codes only, not messages or stack traces. JSON fields reject secret-shaped keys, URLs and token-like values; header names use a small allowlist. Migration 010 is forward-only like the current migration runner; it has no down-migration facility.
