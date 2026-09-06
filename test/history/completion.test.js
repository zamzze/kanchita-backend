'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://history:history@127.0.0.1:5432/history';
process.env.JWT_SECRET ||= 'history-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'history-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'history-test-tmdb-key';

const {
  COMPLETION_THRESHOLD,
  upsertProgress,
} = require('../../src/db/history.queries');
const { createHistoryService } = require('../../src/modules/history/history.service');

test('watch completion has one effective 95 percent backend threshold', async () => {
  assert.equal(COMPLETION_THRESHOLD, 0.95);
  const completedValues = [];
  const db = {
    query: async (sql, values) => {
      assert.match(sql, /INSERT INTO watch_history/);
      completedValues.push(values[5]);
      return { rows: [{ completed: values[5] }] };
    },
  };
  const base = {
    userId: 'user',
    contentType: 'movie',
    contentId: 'movie',
    durationSeconds: 100,
  };

  assert.equal((await upsertProgress(
    { ...base, progressSeconds: 94.99 },
    db
  )).completed, false);
  assert.equal((await upsertProgress(
    { ...base, progressSeconds: 95 },
    db
  )).completed, true);
  assert.deepEqual(completedValues, [false, true]);
});

test('missing history returns a stable zero-progress resume contract', async () => {
  const service = createHistoryService({
    store: {
      findOne: async () => null,
    },
  });
  assert.deepEqual(await service.getProgress('user', 'episode', 'episode'), {
    progress_seconds: 0,
    duration_seconds: null,
    completed: false,
  });
});
