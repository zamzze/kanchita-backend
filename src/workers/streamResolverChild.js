'use strict';

const { resolveStream } = require('../modules/streams/streamResolver');
const {
  validateResolveRequest,
  validateResolverResult,
} = require('../modules/streams/resolverIpc');

let handled = false;

const replyAndDisconnect = (message) => new Promise((resolve) => {
  if (!process.connected) return resolve();
  process.send(message, () => {
    process.disconnect();
    resolve();
  });
});

process.once('message', async (message) => {
  if (handled) return;
  handled = true;
  const context = validateResolveRequest(message);
  if (!context) {
    await replyAndDisconnect({ type: 'FAILURE', code: 'RESOLUTION_FAILED' });
    return;
  }

  try {
    const result = validateResolverResult(await resolveStream(context));
    await replyAndDisconnect(result
      ? { type: 'SUCCESS', result }
      : { type: 'FAILURE', code: 'RESOLUTION_FAILED' });
  } catch {
    await replyAndDisconnect({ type: 'FAILURE', code: 'RESOLUTION_FAILED' });
  }
});

process.once('disconnect', () => {
  if (!handled) process.exitCode = 1;
});
