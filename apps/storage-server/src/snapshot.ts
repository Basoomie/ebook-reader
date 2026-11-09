/**
 * Nightly consistent snapshot of the SQLite database (design doc 4.6).
 *
 * Uses SQLite's online backup API, so it is consistent while the server keeps
 * writing. The snapshots folder lives in appdata next to the database, so the
 * existing restic -> B2 backup picks the snapshots up. Restoring is copying a
 * snapshot over ttsu.db while the server is stopped.
 *
 * Snapshot failures are logged and never affect the server.
 */
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import type { SnapshotTime } from './config';

export const SNAPSHOT_DIRNAME = 'snapshots';
/** ttsu-YYYYMMDD-HHMMSSZ.db, timestamp in UTC. Pruning only ever touches names like this. */
export const SNAPSHOT_PATTERN = /^ttsu-(\d{8})-(\d{6})Z\.db$/;
/** A nightly snapshot older than this means a scheduled run was missed. */
const NIGHTLY_MS = 24 * 60 * 60 * 1000;

export function snapshotDir(dbDir: string): string {
  return path.join(dbDir, SNAPSHOT_DIRNAME);
}

export function snapshotFilename(date: Date): string {
  const iso = date.toISOString(); // 2026-11-08T03:00:00.000Z
  const day = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `ttsu-${day}-${time}Z.db`;
}

function parseSnapshotDate(name: string): Date | null {
  const m = SNAPSHOT_PATTERN.exec(name);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Snapshot files in `dir`, newest first. Ignores anything not named like a snapshot. */
export async function listSnapshots(dir: string): Promise<{ name: string; date: Date }[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .map((name) => ({ name, date: parseSnapshotDate(name) }))
    .filter((s): s is { name: string; date: Date } => s.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Deletes all but the newest `keep` snapshots. Returns the deleted names. */
export async function pruneSnapshots(dir: string, keep: number): Promise<string[]> {
  const snapshots = await listSnapshots(dir);
  const old = snapshots.slice(Math.max(1, keep));
  for (const s of old) await fs.unlink(path.join(dir, s.name));
  return old.map((s) => s.name);
}

/**
 * Writes a verified copy of `db` to `finalPath`: written to a .tmp file,
 * checked with quick_check, then renamed into place.
 */
export async function writeVerifiedCopy(db: Database.Database, finalPath: string): Promise<void> {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  try {
    await db.backup(tmpPath);
    const copy = new Database(tmpPath, { fileMustExist: true });
    try {
      // The copy inherits WAL mode; switch it to a plain single-file database
      // so a snapshot is one self-contained file with no -wal/-shm companions.
      copy.pragma('journal_mode = DELETE');
      const result = copy.pragma('quick_check', { simple: true });
      if (result !== 'ok') throw new Error(`snapshot failed quick_check: ${String(result)}`);
    } finally {
      copy.close();
    }
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await fs.unlink(`${tmpPath}${suffix}`).catch(() => {});
    }
    throw err;
  }
}

/** Writes a verified snapshot of `db` into `dir` and prunes old ones. */
export async function takeSnapshot(
  db: Database.Database,
  dir: string,
  keep: number,
  now = new Date(),
): Promise<string> {
  const finalPath = path.join(dir, snapshotFilename(now));
  await writeVerifiedCopy(db, finalPath);
  await pruneSnapshots(dir, keep);
  return finalPath;
}

/** The next local time at `time` strictly after `now`. */
export function nextRunAt(time: SnapshotTime, now: Date): Date {
  const next = new Date(now);
  next.setHours(time.hour, time.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(time.hour, time.minute, 0, 0);
  }
  return next;
}

/** True when there is no snapshot from the last 24 hours (a nightly run was missed). */
export async function isSnapshotDue(dir: string, now = new Date()): Promise<boolean> {
  const [newest] = await listSnapshots(dir);
  return !newest || now.getTime() - newest.date.getTime() >= NIGHTLY_MS;
}

export interface SnapshotScheduler {
  stop(): void;
  /** Resolves when the startup catch-up check (and snapshot, if due) has finished. */
  ready: Promise<void>;
}

export interface SchedulerOptions {
  db: Database.Database;
  dir: string;
  time: SnapshotTime;
  keep: number;
  log?: (message: string) => void;
  logError?: (message: string, err: unknown) => void;
}

export function scheduleSnapshots({
  db,
  dir,
  time,
  keep,
  log = console.log,
  logError = console.error,
}: SchedulerOptions): SnapshotScheduler {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const run = async (reason: string) => {
    try {
      const file = await takeSnapshot(db, dir, keep);
      log(`Snapshot (${reason}): ${file}`);
    } catch (err) {
      logError(`Snapshot (${reason}) failed:`, err);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const delay = nextRunAt(time, new Date()).getTime() - Date.now();
    timer = setTimeout(async () => {
      await run('nightly');
      scheduleNext();
    }, delay);
    timer.unref();
  };

  const ready = (async () => {
    try {
      if (await isSnapshotDue(dir)) await run('catch-up');
    } catch (err) {
      logError('Snapshot catch-up check failed:', err);
    }
  })();

  scheduleNext();

  return {
    ready,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
