'use strict';

const {
  parsePreflightArgs,
  exitCodeForStatus,
  formatPreflightJson,
  formatPreflightText,
} = require('../src/modules/streams/resolverV2/preflight/preflightCli');
const { PREFLIGHT_CODES } =
  require('../src/modules/streams/resolverV2/preflight/preflightErrors');

const installNonServerDefaults = () => {
  process.env.PORT ||= '3000';
  process.env.DB_URL ||= 'postgresql://preflight.invalid/preflight';
  process.env.JWT_SECRET ||= 'preflight-unused-access-secret';
  process.env.JWT_REFRESH_SECRET ||= 'preflight-unused-refresh-secret';
  process.env.TMDB_API_KEY ||= 'preflight-unused-tmdb-key';
};

const failureResult = (code = PREFLIGHT_CODES.RUNTIME_FAILED) => ({
  status: 'failed', mediaType: null, durationMs: 0, error: { code },
});

const main = async (argv = process.argv.slice(2)) => {
  const parsed = parsePreflightArgs(argv);
  if (!parsed.ok) {
    const result = { status: 'invalid_context', mediaType: null, durationMs: 0,
      error: parsed.error };
    process.stdout.write(`${parsed.json
      ? formatPreflightJson(result) : formatPreflightText(result)}\n`);
    process.exitCode = exitCodeForStatus(result.status, { cliInputInvalid: true });
    return result;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let result;
  try {
    installNonServerDefaults();
    const { createShadowPipeline } =
      require('../src/modules/streams/resolverV2/createShadowPipeline');
    const { createPreflightRunner } =
      require('../src/modules/streams/resolverV2/preflight/preflightRunner');
    const runtime = createShadowPipeline({
      enabled: false,
      primaryEnabled: false,
      timeoutMs: parsed.timeoutMs,
      primaryTimeoutMs: parsed.timeoutMs,
      logger: Object.freeze({ log: () => {}, warn: () => {}, error: () => {} }),
    });
    const runner = createPreflightRunner({
      runtime,
      catalogEnabled: process.env.STREAM_RESOLVER_V2_CATALOG_ENABLED === 'true',
    });
    result = await runner.run(parsed.mediaContext, {
      timeoutMs: parsed.timeoutMs,
      catalogOnly: parsed.catalogOnly,
      signal: controller.signal,
    });
  } catch {
    result = failureResult(controller.signal.aborted
      ? PREFLIGHT_CODES.ABORTED : PREFLIGHT_CODES.RUNTIME_FAILED);
    if (controller.signal.aborted) result.status = 'aborted';
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  process.stdout.write(`${parsed.json
    ? formatPreflightJson(result) : formatPreflightText(result)}\n`);
  process.exitCode = exitCodeForStatus(result.status);
  return result;
};

if (require.main === module) main();

module.exports = { main };
