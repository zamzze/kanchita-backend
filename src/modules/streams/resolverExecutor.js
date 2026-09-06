'use strict';

const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { validateResolveRequest, validateResolverResponse } = require('./resolverIpc');
const {
  STREAM_RESOLUTION_TIMEOUT_MS,
  STREAM_RESOLVER_KILL_GRACE_MS,
} = require('../../config/env');

const CHILD_PATH = path.join(__dirname, '../../workers/streamResolverChild.js');
const ENV_ALLOWLIST = [
  'TMDB_API_KEY', 'NODE_ENV', 'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'DISPLAY',
  'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH', 'XAUTHORITY', 'LANG', 'LC_ALL',
];

const resolverError = (code = 'RESOLUTION_FAILED') => {
  const error = new Error('Resolver subprocess failed');
  error.code = code;
  return error;
};

const resolverEnvironment = (source = process.env) => Object.fromEntries(
  ENV_ALLOWLIST
    .filter((name) => source[name] !== undefined)
    .map((name) => [name, source[name]])
);

const waitForClose = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const runTaskkill = (args) => new Promise((resolve) => {
  const killer = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
  killer.once('error', () => resolve(false));
  killer.once('close', (code) => resolve(code === 0));
});

const terminateProcessTree = async (child, {
  graceMs,
  platform = process.platform,
} = {}) => {
  if (!child?.pid) return;

  const closed = waitForClose(child);
  const childRunning = child.exitCode === null && child.signalCode === null;
  if (platform === 'win32') {
    if (!childRunning) return;
    const treeSignaled = await runTaskkill(['/PID', String(child.pid), '/T']);
    if (!treeSignaled) child.kill('SIGTERM');
  } else {
    try { process.kill(-child.pid, childRunning ? 'SIGTERM' : 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (!childRunning) return;
  }

  const exitedDuringGrace = await Promise.race([
    closed.then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (!exitedDuringGrace) {
    if (platform === 'win32') {
      const treeKilled = await runTaskkill(['/PID', String(child.pid), '/T', '/F']);
      if (!treeKilled) child.kill('SIGKILL');
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  // The leader may exit before Chromium descendants. On POSIX they retain the
  // resolver's isolated PGID, so a final scoped SIGKILL closes that residual tree.
  if (platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await closed;
};

const createResolverExecutor = ({
  childPath = CHILD_PATH,
  timeoutMs = STREAM_RESOLUTION_TIMEOUT_MS,
  killGraceMs = STREAM_RESOLVER_KILL_GRACE_MS,
  logger = console,
  forkImpl = fork,
  terminateTree = terminateProcessTree,
  env = resolverEnvironment(),
  platform = process.platform,
} = {}) => {
  let active = null;
  let shuttingDown = false;

  const resolve = async (context) => {
    if (shuttingDown || active) throw resolverError();
    const request = validateResolveRequest({ type: 'RESOLVE', payload: context });
    if (!request) throw resolverError();

    const startedAt = Date.now();
    const child = forkImpl(childPath, [], {
      detached: platform !== 'win32',
      env,
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    logger.log('[ResolverExecutor] child started');

    let response = null;
    let terminationReason = null;
    let terminationStarted = false;
    let terminationPromise = null;
    let finish;
    const done = new Promise((resolveDone, rejectDone) => {
      finish = { resolve: resolveDone, reject: rejectDone };
    });

    const requestTermination = async (reason) => {
      if (!terminationReason) terminationReason = reason;
      if (terminationStarted) return terminationPromise;
      terminationStarted = true;
      terminationPromise = (async () => {
        try {
          await terminateTree(child, { graceMs: killGraceMs, platform });
        } catch {
          try { child.kill('SIGKILL'); } catch {}
          await waitForClose(child);
        }
      })();
      return terminationPromise;
    };

    const timer = setTimeout(() => {
      logger.warn('[ResolverExecutor] child timeout');
      requestTermination('timeout');
    }, timeoutMs);

    child.on('message', (message) => {
      if (response || terminationReason) return;
      response = validateResolverResponse(message);
      if (!response) requestTermination('invalid-ipc');
    });
    child.once('error', () => requestTermination('child-error'));
    child.once('close', (code, signal) => void (async () => {
      clearTimeout(timer);
      if (terminationStarted) {
        await terminationPromise;
      } else {
        try { await terminateTree(child, { graceMs: 0, platform }); } catch {}
      }
      const duration = Date.now() - startedAt;
      if (terminationReason === 'timeout') {
        logger.warn(`[ResolverExecutor] child failed RESOLUTION_TIMEOUT duration_ms=${duration}`);
        finish.reject(resolverError('RESOLUTION_TIMEOUT'));
      } else if (terminationReason || code !== 0 || signal || !response) {
        logger.warn(`[ResolverExecutor] child failed RESOLUTION_FAILED duration_ms=${duration}`);
        finish.reject(resolverError());
      } else if (response.type === 'FAILURE') {
        logger.warn(`[ResolverExecutor] child failed ${response.code} duration_ms=${duration}`);
        finish.reject(resolverError(response.code));
      } else {
        logger.log(`[ResolverExecutor] child completed duration_ms=${duration}`);
        finish.resolve(response.result);
      }
    })());

    active = { child, done, requestTermination };
    try {
      child.send({ type: 'RESOLVE', payload: request }, (error) => {
        if (error) requestTermination('ipc-send');
      });
    } catch {
      requestTermination('ipc-send');
    }

    try {
      return await done;
    } finally {
      active = null;
    }
  };

  const shutdown = async () => {
    shuttingDown = true;
    const current = active;
    if (current) {
      await current.requestTermination('shutdown');
      await current.done.catch(() => {});
    }
  };

  return {
    resolve,
    shutdown,
    hasActiveChild: () => Boolean(active),
  };
};

module.exports = {
  CHILD_PATH,
  ENV_ALLOWLIST,
  createResolverExecutor,
  resolverEnvironment,
  resolverError,
  terminateProcessTree,
};
