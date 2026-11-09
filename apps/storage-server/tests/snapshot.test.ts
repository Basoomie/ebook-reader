import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../src/db/migrations';
import { openDatabase } from '../src/db/database';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import {
  isSnapshotDue,
  listSnapshots,
  nextRunAt,
  pruneSnapshots,
  scheduleSnapshots,
  snapshotFilename,
  takeSnapshot,
} from '../src/snapshot';
import { makeTempDir } from './helpers/spawn-server';

function dbWithData() {
  const dir = makeTempDir('db');
  const db = openDatabase(path.join(dir, 'ttsu.db'));
  createToken(db, listUsers(db)[0].id, 'Phone');
  return { db, dir, snapDir: path.join(dir, 'snapshots') };
}

describe('snapshotFilename', () => {
  it('uses a UTC timestamp', () => {
    expect(snapshotFilename(new Date('2026-11-08T03:04:05.678Z'))).toBe('ttsu-20261108-030405Z.db');
  });
});

describe('takeSnapshot', () => {
  it('writes a complete, readable copy and no temp file', async () => {
    const { db, snapDir } = dbWithData();
    const file = await takeSnapshot(db, snapDir, 7, new Date('2026-11-08T03:00:00Z'));
    expect(path.basename(file)).toBe('ttsu-20261108-030000Z.db');
    expect(fs.readdirSync(snapDir)).toEqual(['ttsu-20261108-030000Z.db']);

    const copy = new Database(file, { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect((copy.prepare('SELECT label FROM api_tokens').get() as any).label).toBe('Phone');
    copy.close();
  });

  it('keeps only the newest N and leaves other files alone', async () => {
    const { db, snapDir } = dbWithData();
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'my-notes.txt'), 'keep me');
    fs.writeFileSync(path.join(snapDir, 'ttsu-manual-copy.db'), 'keep me too');

    for (let day = 1; day <= 5; day++) {
      await takeSnapshot(db, snapDir, 3, new Date(`2026-11-0${day}T03:00:00Z`));
    }
    expect(fs.readdirSync(snapDir).sort()).toEqual([
      'my-notes.txt',
      'ttsu-20261103-030000Z.db',
      'ttsu-20261104-030000Z.db',
      'ttsu-20261105-030000Z.db',
      'ttsu-manual-copy.db',
    ]);
  });

  it('rejects and cleans up when the backup fails', async () => {
    const { db, snapDir } = dbWithData();
    db.close();
    await expect(takeSnapshot(db, snapDir, 7)).rejects.toThrow();
    expect(fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : []).toEqual([]);
  });
});

describe('pruneSnapshots / listSnapshots', () => {
  it('handles a missing folder', async () => {
    const dir = path.join(makeTempDir('snap'), 'missing');
    expect(await listSnapshots(dir)).toEqual([]);
    expect(await pruneSnapshots(dir, 3)).toEqual([]);
  });
});

describe('nextRunAt', () => {
  it('picks today when the time is still ahead, else tomorrow (local time)', () => {
    const now = new Date(2026, 10, 8, 2, 30, 0);
    expect(nextRunAt({ hour: 3, minute: 0 }, now)).toEqual(new Date(2026, 10, 8, 3, 0, 0));
    expect(nextRunAt({ hour: 2, minute: 30 }, now)).toEqual(new Date(2026, 10, 9, 2, 30, 0));
    expect(nextRunAt({ hour: 1, minute: 0 }, now)).toEqual(new Date(2026, 10, 9, 1, 0, 0));
  });
});

describe('isSnapshotDue', () => {
  it('is due with no snapshots or when the newest is a day old', async () => {
    const { db, snapDir } = dbWithData();
    const now = new Date('2026-11-08T12:00:00Z');
    expect(await isSnapshotDue(snapDir, now)).toBe(true);

    await takeSnapshot(db, snapDir, 7, new Date('2026-11-08T03:00:00Z'));
    expect(await isSnapshotDue(snapDir, now)).toBe(false);
    expect(await isSnapshotDue(snapDir, new Date('2026-11-09T03:00:00Z'))).toBe(true);
  });
});

describe('scheduleSnapshots', () => {
  it('takes a catch-up snapshot at startup when none is recent', async () => {
    const { db, snapDir } = dbWithData();
    const log = vi.fn();
    const scheduler = scheduleSnapshots({
      db,
      dir: snapDir,
      time: { hour: 3, minute: 0 },
      keep: 7,
      log,
    });
    await scheduler.ready;
    scheduler.stop();
    expect((await listSnapshots(snapDir)).length).toBe(1);
    expect(log.mock.calls[0][0]).toContain('catch-up');
  });

  it('skips the catch-up when a recent snapshot exists', async () => {
    const { db, snapDir } = dbWithData();
    await takeSnapshot(db, snapDir, 7);
    const scheduler = scheduleSnapshots({
      db,
      dir: snapDir,
      time: { hour: 3, minute: 0 },
      keep: 7,
    });
    await scheduler.ready;
    scheduler.stop();
    expect((await listSnapshots(snapDir)).length).toBe(1);
  });

  it('logs failures instead of throwing', async () => {
    const { db, snapDir } = dbWithData();
    db.close();
    const logError = vi.fn();
    const scheduler = scheduleSnapshots({
      db,
      dir: snapDir,
      time: { hour: 3, minute: 0 },
      keep: 7,
      logError,
    });
    await expect(scheduler.ready).resolves.toBeUndefined();
    scheduler.stop();
    expect(logError).toHaveBeenCalled();
  });

  it('runs at the configured time and reschedules', async () => {
    // Only fake the scheduler's clock; better-sqlite3's backup steps use setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { db, snapDir } = dbWithData();
      vi.setSystemTime(new Date(2026, 10, 8, 2, 59, 0));
      await takeSnapshot(db, snapDir, 7); // recent, so no catch-up
      const log = vi.fn();
      const scheduler = scheduleSnapshots({
        db,
        dir: snapDir,
        time: { hour: 3, minute: 0 },
        keep: 7,
        log,
      });
      await scheduler.ready;
      expect(log).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(61_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(log.mock.calls[0][0]).toContain('nightly');
      expect(vi.getTimerCount()).toBe(1); // next night is scheduled
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
