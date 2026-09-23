'use strict';

const { uuid } = require('../../db/bulkPersistence.validation');
const { normalizeMedia, normalizeMappingResult } = require('./mappingContract');

const invalid = (code) => Object.assign(new Error(code), { code });
const positive = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--';
  const total = Math.floor(seconds);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
};

const formatMappingProgress = ({ progress, providerId = '-', runId = null,
  startedAt, now = Date.now() }) => {
  const elapsed = Math.max(0, now - startedAt) / 1000;
  const rate = elapsed > 0 ? progress.processed / elapsed : 0;
  const remaining = Math.max(0, progress.total - progress.processed);
  const percentage = progress.total > 0
    ? (100 * progress.processed / progress.total).toFixed(1) : '100.0';
  return `Mapping ingestion\nProcessed: ${progress.processed} / ${progress.total} ` +
    `(${percentage}%)\nMapped: ${progress.mapped}\n` +
    `No mapping: ${progress.no_mapping}\nSkipped: ${progress.skipped}\n` +
    `Failed: ${progress.failed}\nProvider: ${providerId}\n` +
    `Elapsed: ${formatTime(elapsed)}\nRate: ${rate.toFixed(1)} items/s\n` +
    `ETA: ${rate > 0 ? formatTime(remaining / rate) : '--:--:--'}\n` +
    `Run: ${runId || 'dry-run'}`;
};

const normalizeOptions = (input) => {
  if (!input || typeof input !== 'object' ||
      !positive(input.targetMappings ?? 2, 32) ||
      !positive(input.workers ?? 2, 8) ||
      !positive(input.batchSize ?? 25, 100) ||
      (input.limit != null && !positive(input.limit, 100_000)) ||
      (input.providers != null && (!Array.isArray(input.providers) ||
        input.providers.some((id) => typeof id !== 'string'))) ||
      (input.resume != null && !uuid(input.resume)) ||
      (input.resume != null && (input.dryRun || input.providers != null ||
        input.limit != null || input.targetMappings != null ||
        input.workers != null || input.batchSize != null))) {
    throw invalid('BULK_MAPPING_INVALID_OPTIONS');
  }
  return Object.freeze({ limit: input.limit ?? null,
    providers: input.providers ?? null, targetMappings: input.targetMappings ?? 2,
    workers: input.workers ?? 2, batchSize: input.batchSize ?? 25,
    dryRun: input.dryRun === true, resume: input.resume ?? null });
};

const createBulkMappingWorker = ({ registry, bulkStore, runStore, mappingStore,
  logger = () => {}, now = () => Date.now() } = {}) => {
  if (!registry || typeof registry.select !== 'function' ||
      typeof registry.execute !== 'function' || !bulkStore ||
      typeof bulkStore.findActiveMappings !== 'function' ||
      typeof bulkStore.createRunWithItems !== 'function' ||
      typeof runStore?.claimNextPendingItems !== 'function' ||
      typeof mappingStore?.upsertMapping !== 'function' ||
      typeof logger !== 'function' || typeof now !== 'function') {
    throw invalid('BULK_MAPPING_INVALID_CONFIG');
  }
  let stopRequested = false;
  const stop = () => { stopRequested = true; };

  const processMedia = async (media, providers, target, dryRun) => {
    const existing = await bulkStore.findActiveMappings(media);
    if (!Array.isArray(existing)) throw invalid('BULK_MAPPING_INVALID_MAPPINGS');
    let mappingCount = existing.length;
    if (mappingCount >= target) {
      return { status: 'skipped', mappingCount, providerId: '-' };
    }
    let failedProvider = false;
    let providerId = '-';
    const virtual = new Set(existing.map((row) =>
      `${row.provider_id}:${row.region}:${row.external_id}`));
    for (const provider of providers) {
      if (mappingCount >= target || stopRequested) break;
      if (media.contentType === 'movie' && !provider.supportsMovies ||
          media.contentType !== 'movie' && !provider.supportsSeries) continue;
      providerId = provider.id;
      try {
        const found = await registry.execute(provider, media);
        if (!Array.isArray(found) || found.length > 16) {
          throw invalid('MAPPING_PROVIDER_INVALID_RESULT');
        }
        for (const raw of found) {
          if (mappingCount >= target) break;
          const mapping = normalizeMappingResult(provider, media, raw, new Date(now()));
          if (!mapping) { failedProvider = true; continue; }
          const identity = `${mapping.providerId}:${mapping.region}:${mapping.externalId}`;
          if (dryRun) {
            if (!virtual.has(identity)) { virtual.add(identity); mappingCount += 1; }
          } else {
            const result = await mappingStore.upsertMapping(mapping);
            if (result?.change === 'conflict') continue;
            mappingCount = (await bulkStore.findActiveMappings(media)).length;
          }
        }
      } catch { failedProvider = true; }
    }
    const status = mappingCount >= target ? 'completed'
      : failedProvider ? 'failed' : mappingCount > 0 ? 'completed' : 'no_mapping';
    return { status, mappingCount, providerId };
  };

  const run = async (rawOptions = {}) => {
    stopRequested = false;
    const options = normalizeOptions(rawOptions);
    let runRow = null;
    let config = options;
    if (options.resume) {
      runRow = await runStore.getRun(options.resume);
      if (!runRow || runRow.run_type !== 'provider_mapping' ||
          !['pending', 'paused', 'failed', 'running'].includes(runRow.status)) {
        throw invalid('BULK_MAPPING_NOT_RESUMABLE');
      }
      config = normalizeOptions(runRow.config_json);
    }
    const providers = registry.select(config.providers);
    const startedAt = now();
    if (config.dryRun) {
      const rows = await bulkStore.listMedia(config.limit);
      const progress = { total: rows.length, processed: 0, mapped: 0,
        no_mapping: 0, skipped: 0, failed: 0 };
      for (let index = 0; index < rows.length && !stopRequested;
        index += config.batchSize) {
        let lastProvider = '-';
        for (const row of rows.slice(index, index + config.batchSize)) {
          const media = normalizeMedia({ contentType: row.content_type,
            tmdbId: row.tmdb_id, title: row.title,
            originalTitle: row.original_title, year: row.release_year,
            season: row.season_number, episode: row.episode_number });
          const outcome = media ? await processMedia(media, providers,
            config.targetMappings, true) : { status: 'failed', providerId: '-' };
          lastProvider = outcome.providerId;
          progress.processed += 1;
          progress[outcome.status === 'completed' ? 'mapped' :
            outcome.status === 'no_mapping' ? 'no_mapping' : outcome.status] += 1;
        }
        try { logger(formatMappingProgress({ progress,
          providerId: lastProvider, startedAt, now: now() })); }
        catch { /* Diagnostics cannot change the run. */ }
      }
      return Object.freeze({ runId: null, status: 'dry_run', progress,
        elapsedMs: Math.max(0, now() - startedAt) });
    }
    if (!runRow) {
      runRow = await bulkStore.createRunWithItems({ limit: config.limit,
        providers: config.providers, targetMappings: config.targetMappings,
        workers: config.workers, batchSize: config.batchSize });
    }
    return bulkStore.withRunLock(runRow.id, async () => {
      if (runRow.status === 'running') await bulkStore.recoverRunningRun(runRow.id);
      if (runRow.status === 'failed') await bulkStore.requeueFailed(runRow.id);
      if (runRow.status !== 'running') {
        const resumed = await runStore.resumeRun(runRow.id);
        if (!resumed) throw invalid('BULK_MAPPING_NOT_RESUMABLE');
      }
      await runStore.updateCounters(runRow.id);
      const lane = async () => {
        while (!stopRequested) {
          const items = await runStore.claimNextPendingItems(runRow.id, config.batchSize);
          if (!items.length) break;
          let lastProvider = '-';
          for (const item of items) {
            try {
              const row = await bulkStore.loadItemMedia(runRow.id, item.id);
              const media = normalizeMedia({ contentType: row?.content_type,
                tmdbId: row?.tmdb_id, title: row?.title,
                originalTitle: row?.original_title, year: row?.release_year,
                season: row?.season_number, episode: row?.episode_number });
              if (!media) throw invalid('BULK_MAPPING_MEDIA_INVALID');
              const outcome = await processMedia(media, providers,
                config.targetMappings, false);
              lastProvider = outcome.providerId;
              if (outcome.status === 'failed') {
                await runStore.markItemFailed({ itemId: item.id,
                  code: 'MAPPING_DISCOVERY_FAILED' });
              } else {
                await runStore.markItemCompleted({ itemId: item.id,
                  status: outcome.status, mappingCount: outcome.mappingCount });
              }
            } catch {
              await runStore.markItemFailed({ itemId: item.id,
                code: 'MAPPING_ITEM_FAILED' });
            }
          }
          await runStore.updateCounters(runRow.id);
          const progress = await bulkStore.progress(runRow.id);
          try { logger(formatMappingProgress({ progress,
            providerId: lastProvider, runId: runRow.id, startedAt, now: now() })); }
          catch { /* Diagnostics cannot change the run. */ }
        }
      };
      const lanes = await Promise.allSettled(Array.from({ length: config.workers },
        async () => {
          try { await lane(); }
          catch (error) { stopRequested = true; throw error; }
        }));
      const fatal = lanes.find((result) => result.status === 'rejected');
      if (fatal) {
        await bulkStore.pauseRun(runRow.id);
        throw fatal.reason;
      }
      await runStore.updateCounters(runRow.id);
      const progress = await bulkStore.progress(runRow.id);
      const finalRun = stopRequested ? await bulkStore.pauseRun(runRow.id)
        : await bulkStore.finishRun(runRow.id);
      return Object.freeze({ runId: runRow.id,
        status: finalRun?.status || 'running', progress,
        elapsedMs: Math.max(0, now() - startedAt) });
    });
  };
  return Object.freeze({ run, stop });
};

module.exports = { createBulkMappingWorker, formatMappingProgress,
  normalizeOptions };
