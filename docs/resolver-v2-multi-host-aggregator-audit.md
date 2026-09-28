# Resolver V2: MULTI_HOST_AGGREGATOR audit

Status: `READY_FOR_MULTI_HOST_AGGREGATOR` for the bounded, local generic
candidate/stream path. This is not a live-host availability result and no
host-specific provider or resolver was registered.

## What already works

- A source workflow can emit bounded `EmbedCandidate[]` with per-option URL,
  `languageHint`, `qualityHint`, headers, and JSON-safe metadata. Its
  `emitEach` preserves input order and structured fields from the same row.
- `SourceProviderManager` combines providers in descriptor priority order,
  keeps each provider's candidate order, and deduplicates identical normalized
  options. Same-URL options with different language or variant metadata can
  leave the manager separately. Per-provider and global candidate caps apply.
- `ResolverRegistry` detects resolvers by URL/domain/path descriptor and sorts
  compatible resolvers by priority, then ID. Different host URLs can dispatch
  to different resolver families; no hostname switch is required in the engine.
- `ResolverEngine` processes candidates/resolvers deterministically, continues
  after an empty or operationally failed resolver, and collects multiple
  streams up to `maxStreams`. Legacy fallback runs only if V2 found no stream.
  The ranker can then order validated streams using language, quality,
  protocol, descriptor priorities, latency, and expiry.

## Gaps found and closed

1. **Same URL, distinct option semantics:** the manager preserves two options
   with the same provider/URL but different language/variant. The engine's
   `graphCandidateIdentity` omits language, quality, and option metadata for
   its visited key. A local fake-resolver probe with `es-419` and `en` options
   at the same URL yielded one resolver call and one stream (`nodesSkippedVisited=1`).
   The engine now uses a semantic option identity for root/same-parent
   duplicates, while a separate URL-based ancestry key prevents cycles only
   within each resolution branch. Sibling roots no longer share visited state.
   Final stream deduplication includes protocol, language, quality, and
   normalized metadata in addition to URL, provider, headers, and expiry.
2. **Metadata continuity:** `DirectHlsResolver` preserves language and quality
   hints but did not copy existing JSON-safe candidate metadata into its
   stream. It now retains that metadata, including variant/source labels and
   source priority, without changing the global candidate/stream schema.

## Remaining boundaries

- Operational failure or empty output permits later
   compatible resolvers/candidates. However, when a URL matches a specific
   descriptor, the registry suppresses generic resolvers for that URL. Legacy
   fallback is global and only runs when V2 produced zero streams. A desired
   generic-after-specific fallback would need a separate policy decision.
- `SourceProviderManager` uses referer/origin and option metadata for dedupe,
  but does not distinguish arbitrary other playback headers on an otherwise
  identical same-URL option. Header-distinct variants require a separate
  security and identity review before claiming coverage of that case.
- Branch-local graph visits may reprocess a diamond's shared child from two
  independent branches. The existing global node/depth/stream limits still
  bound work; final identical streams collapse.

## Local conformance

- A local HLS server verifies same-URL `es-419`/`en` options remain two
  validated streams, while an identical option collapses and same-language
  variant 1/2 survives. A source-manager-to-pipeline fixture checks metadata,
  source priority, and deterministic ranking end to end.
- Fake local resolvers verify `A → B → A` stops, independent siblings do not
  contaminate visited state, and empty/failed options allow later success.
- Existing registry/server-pipeline suites cover descriptor-based dispatch to
  distinct resolver families without external hosts or browser use.

No real provider, hoster, playback integration, or availability is asserted.
