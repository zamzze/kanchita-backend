'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://resolver:resolver@127.0.0.1:5432/resolver';
process.env.JWT_SECRET ||= 'resolver-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'resolver-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'resolver-test-tmdb-key';

const {
  createResolverExecutor,
  resolverEnvironment,
} = require('../../src/modules/streams/resolverExecutor');
const { createStreamWorker } = require('../../src/workers/streamResolutionWorker');

const childPath = path.join(__dirname, '../fixtures/resolver-child.js');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const context = (title = 'success', contentType = 'movie') => ({
  contentType,
  contentId: crypto.randomUUID(),
  tmdbId: 12345,
  title,
  season: contentType === 'episode' ? 1 : null,
  episode: contentType === 'episode' ? 2 : null,
});
const loggerFixture = () => {
  const messages = [];
  return {
    messages,
    log: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
};

test('resolver subprocess isolation and IPC contract', async (t) => {
  await t.test('success returns validated movie and episode results after child exit', async () => {
    for (const contentType of ['movie', 'episode']) {
      let childPid;
      const logger = loggerFixture();
      const executor = createResolverExecutor({
        childPath,
        timeoutMs: 1000,
        logger,
        forkImpl: (...args) => {
          const child = fork(...args);
          childPid = child.pid;
          return child;
        },
      });
      const result = await executor.resolve(context('success', contentType));
      assert.match(result.url, new RegExp(`/${contentType}\\.m3u8`));
      assert.equal(result.provider, 'fixture');
      assert.equal(executor.hasActiveChild(), false);
      assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process/i);
      assert.doesNotMatch(logger.messages.join('\n'), /ipc-secret|token=|\.m3u8/);
    }
  });

  await t.test('safe failure, invalid IPC and unexpected exit are contained', async () => {
    for (const mode of ['failure', 'invalid-ipc', 'crash']) {
      const executor = createResolverExecutor({ childPath, timeoutMs: 1000 });
      await assert.rejects(
        executor.resolve(context(mode)),
        (error) => error.code === 'RESOLUTION_FAILED' && !/token=/.test(error.message)
      );
      assert.equal(executor.hasActiveChild(), false);
    }
  });

  await t.test('invalid parent payload never starts a subprocess', async () => {
    let forks = 0;
    const executor = createResolverExecutor({
      childPath,
      forkImpl: (...args) => {
        forks += 1;
        return fork(...args);
      },
    });
    await assert.rejects(
      executor.resolve({ ...context(), contentType: 'series' }),
      (error) => error.code === 'RESOLUTION_FAILED'
    );
    assert.equal(forks, 0);
  });

  await t.test('timeout kills and reaps the resolver process tree', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kanchita-resolver-'));
    const heartbeatPath = path.join(temporaryDirectory, 'heartbeat.txt');
    let childPid;
    const logger = loggerFixture();
    const executor = createResolverExecutor({
      childPath,
      timeoutMs: 150,
      killGraceMs: 50,
      logger,
      forkImpl: (...args) => {
        const child = fork(...args);
        childPid = child.pid;
        return child;
      },
    });

    const hangMode = process.platform === 'win32'
      ? 'hang'
      : `hang-tree:${heartbeatPath}`;
    if (process.platform === 'win32') await fs.writeFile(heartbeatPath, 'windows-direct-child');
    await assert.rejects(
      executor.resolve(context(hangMode)),
      (error) => error.code === 'RESOLUTION_TIMEOUT'
    );
    assert.equal(executor.hasActiveChild(), false);
    assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process/i);
    const sizeAfterKill = (await fs.stat(heartbeatPath)).size;
    await delay(100);
    assert.equal((await fs.stat(heartbeatPath)).size, sizeAfterKill);
    assert.ok(logger.messages.some((message) => message.includes('child timeout')));
    assert.doesNotMatch(logger.messages.join('\n'), /ipc-secret|token=/);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  await t.test(
    'unexpected child exit also terminates its residual process group',
    { skip: process.platform === 'win32' ? 'POSIX process-group guarantee' : false },
    async () => {
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kanchita-crash-'));
      const heartbeatPath = path.join(temporaryDirectory, 'heartbeat.txt');
      const executor = createResolverExecutor({ childPath, timeoutMs: 3000, killGraceMs: 25 });
      await assert.rejects(
        executor.resolve(context(`crash-tree:${heartbeatPath}`)),
        (error) => error.code === 'RESOLUTION_FAILED'
      );
      const sizeAfterCleanup = (await fs.stat(heartbeatPath)).size;
      await delay(100);
      assert.equal((await fs.stat(heartbeatPath)).size, sizeAfterCleanup);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  );

  await t.test('one executor never owns two children simultaneously', async () => {
    let forks = 0;
    const executor = createResolverExecutor({
      childPath,
      timeoutMs: 5000,
      killGraceMs: 25,
      forkImpl: (...args) => {
        forks += 1;
        return fork(...args);
      },
    });
    const first = executor.resolve(context('hang'));
    while (!executor.hasActiveChild()) await delay(5);
    await assert.rejects(executor.resolve(context()), (error) => error.code === 'RESOLUTION_FAILED');
    assert.equal(forks, 1);
    const rejected = assert.rejects(first, (error) => error.code === 'RESOLUTION_FAILED');
    await executor.shutdown();
    await rejected;
  });

  await t.test('shutdown terminates and reaps an active child', async () => {
    let childPid;
    const executor = createResolverExecutor({
      childPath,
      timeoutMs: 5000,
      killGraceMs: 25,
      forkImpl: (...args) => {
        const child = fork(...args);
        childPid = child.pid;
        return child;
      },
    });
    const resolving = executor.resolve(context('hang'));
    const rejected = assert.rejects(
      resolving,
      (error) => error.code === 'RESOLUTION_FAILED'
    );
    while (!executor.hasActiveChild()) await delay(5);
    await executor.shutdown();
    await rejected;
    assert.equal(executor.hasActiveChild(), false);
    assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process/i);
  });

  await t.test('worker survives child failure and processes the next job', async () => {
    const executor = createResolverExecutor({ childPath, timeoutMs: 1000 });
    const processor = (job) => executor.resolve(job.context);
    processor.shutdown = () => executor.shutdown();
    const jobs = [
      { id: crypto.randomUUID(), context: context('failure') },
      { id: crypto.randomUUID(), context: context('success') },
    ];
    const failed = [];
    const completed = [];
    const queue = {
      recoverStaleJobs: async () => [],
      claimNextJob: async () => jobs.shift() || null,
      completeJob: async (id) => completed.push(id),
      failJob: async (id, workerId, code) => failed.push({ id, workerId, code }),
    };
    const worker = createStreamWorker({
      queue,
      processor,
      logger: loggerFixture(),
      workerId: 'resolver-process-worker',
      leaseSeconds: 60,
      resolutionTimeoutMs: 1000,
      resolverKillGraceMs: 50,
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].code, 'RESOLUTION_FAILED');
    assert.equal(worker.isStopping(), false);
    assert.equal(await worker.runOnce(), true);
    assert.equal(completed.length, 1);
  });

  await t.test('worker survives a killed timeout child and processes the next job', async () => {
    const executor = createResolverExecutor({
      childPath,
      timeoutMs: 150,
      killGraceMs: 25,
    });
    const processor = (job) => executor.resolve(job.context);
    processor.shutdown = () => executor.shutdown();
    const jobs = [
      { id: crypto.randomUUID(), context: context('hang') },
      { id: crypto.randomUUID(), context: context('success') },
    ];
    const failureCodes = [];
    let completed = 0;
    const queue = {
      recoverStaleJobs: async () => [],
      claimNextJob: async () => jobs.shift() || null,
      completeJob: async () => { completed += 1; },
      failJob: async (id, workerId, code) => failureCodes.push(code),
    };
    const worker = createStreamWorker({
      queue,
      processor,
      logger: loggerFixture(),
      workerId: 'timeout-resolver-worker',
      leaseSeconds: 60,
      resolutionTimeoutMs: 150,
      resolverKillGraceMs: 25,
    });

    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(failureCodes, ['RESOLUTION_TIMEOUT']);
    assert.equal(worker.isStopping(), false);
    assert.equal(await worker.runOnce(), true);
    assert.equal(completed, 1);
  });

  await t.test('worker shutdown terminates its active resolver child before returning', async () => {
    const executor = createResolverExecutor({
      childPath,
      timeoutMs: 5000,
      killGraceMs: 25,
    });
    const processor = (job) => executor.resolve(job.context);
    processor.shutdown = () => executor.shutdown();
    let claims = 0;
    let failures = 0;
    const queue = {
      recoverStaleJobs: async () => [],
      claimNextJob: async () => {
        claims += 1;
        return claims === 1
          ? { id: crypto.randomUUID(), context: context('hang') }
          : null;
      },
      completeJob: async () => {},
      failJob: async () => { failures += 1; },
    };
    const worker = createStreamWorker({
      queue,
      processor,
      logger: loggerFixture(),
      workerId: 'shutdown-resolver-worker',
      leaseSeconds: 60,
      resolutionTimeoutMs: 1000,
      resolverKillGraceMs: 25,
    });
    const running = worker.runOnce();
    while (!executor.hasActiveChild()) await delay(5);
    await worker.shutdown();
    await running;

    assert.equal(worker.isStopping(), true);
    assert.equal(executor.hasActiveChild(), false);
    assert.equal(failures, 1);
    assert.equal(await worker.runOnce(), false);
    assert.equal(claims, 1);
  });

  await t.test('child environment excludes database, JWT and unrelated secrets', () => {
    const selected = resolverEnvironment({
      PATH: 'fixture-path',
      TMDB_API_KEY: 'needed-by-current-provider',
      DB_URL: 'must-not-cross-boundary',
      JWT_SECRET: 'must-not-cross-boundary',
      RANDOM_SECRET: 'must-not-cross-boundary',
    });
    assert.deepEqual(selected, {
      TMDB_API_KEY: 'needed-by-current-provider',
      PATH: 'fixture-path',
    });
  });
});
