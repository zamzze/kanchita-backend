'use strict';

const pool = require('../../config/db');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const createBrowserSlotManager = (db = pool, {
  maxConcurrent = 1,
  leaseSeconds = 120,
  pollMs = 100,
  waitTimeoutMs = 90_000,
  sleep = delay,
  metrics = { observe: async () => {} },
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) => {
  const ensureSlots = async () => {
    await db.query(
      `INSERT INTO stream_browser_slots (slot_number)
       SELECT value FROM generate_series(1, $1::integer) AS value
       ON CONFLICT (slot_number) DO NOTHING`,
      [maxConcurrent]
    );
  };

  const acquire = async (owner) => {
    const startedAt = Date.now();
    await ensureSlots();
    while (Date.now() - startedAt < waitTimeoutMs) {
      const { rows } = await db.query(
        `WITH candidate AS (
           SELECT slot_number FROM stream_browser_slots
           WHERE slot_number <= $1
             AND (owner IS NULL OR lease_expires_at <= NOW())
           ORDER BY slot_number
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE stream_browser_slots AS slots
         SET owner = $2, acquired_at = NOW(),
             lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 second')
         FROM candidate
         WHERE slots.slot_number = candidate.slot_number
         RETURNING slots.slot_number, slots.owner, slots.acquired_at, slots.lease_expires_at`,
        [maxConcurrent, owner, leaseSeconds]
      );
      if (rows[0]) {
        await metrics.observe('browser_slot_wait_ms', Date.now() - startedAt);
        return rows[0];
      }
      await sleep(pollMs);
    }
    const error = new Error('Browser capacity unavailable');
    error.code = 'RESOLUTION_FAILED';
    throw error;
  };

  const release = async (slotNumber, owner) => {
    await db.query(
      `UPDATE stream_browser_slots
       SET owner = NULL, acquired_at = NULL, lease_expires_at = NULL
       WHERE slot_number = $1 AND owner = $2`,
      [slotNumber, owner]
    );
  };

  const renew = async (slotNumber, owner) => {
    const { rowCount } = await db.query(
      `UPDATE stream_browser_slots
       SET lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 second')
       WHERE slot_number = $1 AND owner = $2 AND lease_expires_at > NOW()`,
      [slotNumber, owner, leaseSeconds]
    );
    return rowCount === 1;
  };

  const withSlot = async (owner, operation) => {
    const slot = await acquire(owner);
    const renewalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3));
    const renewal = setTimer(() => {
      renew(slot.slot_number, owner).catch(() => {});
    }, renewalMs);
    renewal.unref?.();
    try {
      return await operation();
    } finally {
      clearTimer(renewal);
      await release(slot.slot_number, owner);
    }
  };

  return { acquire, ensureSlots, release, renew, withSlot };
};

module.exports = { createBrowserSlotManager };
