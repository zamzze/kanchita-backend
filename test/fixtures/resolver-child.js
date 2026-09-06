'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

if (process.argv[2] === 'grandchild') {
  const heartbeatPath = process.argv[3];
  setInterval(() => fs.appendFileSync(heartbeatPath, 'g'), 15);
  return;
}

const reply = (message) => process.send(message, () => process.disconnect());

process.once('message', (message) => {
  const mode = message?.payload?.title || '';
  if (mode === 'failure') {
    reply({ type: 'FAILURE', code: 'RESOLUTION_FAILED' });
    return;
  }
  if (mode === 'invalid-ipc') {
    reply({ type: 'SUCCESS', result: { url: 'not-a-url', detail: 'token=hidden' } });
    return;
  }
  if (mode === 'crash') process.exit(23);
  if (mode.startsWith('crash-tree:')) {
    const heartbeatPath = mode.slice('crash-tree:'.length);
    spawn(process.execPath, [__filename, 'grandchild', heartbeatPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const startedAt = Date.now();
    const waitForGrandchild = setInterval(() => {
      try {
        if (fs.statSync(heartbeatPath).size > 0) {
          clearInterval(waitForGrandchild);
          process.exit(23);
        }
      } catch {}
      if (Date.now() - startedAt > 1000) process.exit(24);
    }, 10);
    return;
  }
  if (mode.startsWith('hang-tree:')) {
    const heartbeatPath = mode.slice('hang-tree:'.length);
    spawn(process.execPath, [__filename, 'grandchild', heartbeatPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    setInterval(() => fs.appendFileSync(heartbeatPath, 'p'), 15);
    return;
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }

  reply({
    type: 'SUCCESS',
    result: {
      url: `https://media.example.test/${message.payload.contentType}.m3u8?token=ipc-secret`,
      provider: 'fixture',
      quality: 'auto',
      language: 'en-sub',
      expiresAt: null,
    },
  });
});
