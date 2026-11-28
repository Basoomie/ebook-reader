/**
 * The metadata.db copy's worker thread (2026-11-26). better-sqlite3 runs every backup step on
 * the thread that called it, one step per turn of that thread's event loop; on the server's
 * busy main thread (seconds per turn on the NAS) a 165 MB copy in 100-page steps took longer
 * than 600 s, while the same copy took 1.9 s in an idle process. Here the copy, its
 * quick_check, the library_id read and (when asked) the SHA-256 of the copy run on a thread of
 * their own, so they take as long as the disk needs, never as long as the server is busy.
 *
 * Reads the source read-only (source-fs.ts); writes only the temporary copy it was given.
 *
 * Calibre's lock (2026-11-27). SQLite's backup holds a read lock on metadata.db while each
 * step runs, and Calibre waits at most 10 s for its database (BUSY_TIMEOUT, calibre 9.18): on
 * the busy NAS a one-step copy read cold pages for 17-35 s under that lock, Calibre's start
 * failed with "database is locked" (shown as "appears to be corrupted") and two of its writes
 * were refused. So the file is first read with plain reads, which take no lock at all, and
 * that copy is kept when Calibre committed nothing meanwhile: in rollback-journal mode every
 * commit changes the header's file change counter (offset 24), and a journal file exists from
 * before Calibre's first page write until its commit.
 *
 * Never a long lock (2026-11-28). When Calibre wrote during the plain reads, SQLite's backup
 * makes the copy in steps, each sized from the last step's pace so that it holds the lock at
 * most about `maxLockMs` (well under Calibre's 10 s); Calibre commits between two steps. Until
 * then the backup ran in one step "from memory", but the NAS's 1 GB disk cache lets a busy disk
 * push metadata.db out of memory: that step held the lock 53 s and a cleanup move's remove was
 * refused. A backup Calibre restarts again and again is given up, the plain reads are tried
 * again, and when nothing worked within `budgetMs` the copy is postponed (`kind: 'postponed'`)
 * and the callers try again later. The longest time one step held the lock is `lockMs`.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { openSourceDatabase } from './source-fs';

export interface SnapshotJob {
  source: string;
  tmp: string;
  /** A backup step is sized to hold metadata.db's read lock at most about this long (ms). */
  maxLockMs: number;
  /** Pages of the first backup step (later steps are sized from its pace). */
  firstStepPages: number;
  /** A backup Calibre restarted this many times (it wrote between steps) is given up. */
  maxRestarts: number;
  /** Plain reads, then short-lock backups, are tried this long before the copy is postponed. */
  budgetMs: number;
  /** Also return the copy's SHA-256 (a cleanup batch's copy). */
  hash: boolean;
  /** Lock-free reads tried before each backup (0 = the backup only). */
  lockFreeTries: number;
}

export type SnapshotJobResult =
  | {
      ok: true;
      libraryUuid: string;
      sha256: string | null;
      steps: number;
      restarts: number;
      copyMs: number;
      checkMs: number;
      /** The copy came from a plain read: metadata.db was never locked. */
      lockFree: boolean;
      /** Lock-free reads made (the last one kept when `lockFree`). */
      lockFreeTries: number;
      /** Short-lock backups started (given-up ones included). */
      backups: number;
      /** Time spent on the lock-free reads (part of copyMs). */
      readMs: number;
      /** Longest time one backup step held metadata.db's read lock; 0 when none ran. */
      lockMs: number;
    }
  | { ok: false; kind: 'skipped' | 'failed' | 'error'; message: string }
  | {
      /** Calibre kept writing: no copy within the budget; try again later. */
      ok: false;
      kind: 'postponed';
      message: string;
      lockFreeTries: number;
      backups: number;
      lockMs: number;
    };

const CHUNK = 1 << 20;

/** better-sqlite3 takes 0..2^31-1 pages per step (not SQLite's -1 for "all"). */
const MAX_STEP_PAGES = 0x7fffffff;
/** The smallest step, so a slow disk still makes progress. */
const MIN_STEP_PAGES = 16;

/** Thrown from the backup's progress callback to give the backup up (its lock is released). */
class GiveUp extends Error {}

/**
 * The wait before a refused step is tried again: 1-5 ms, at random so the tries don't fall in
 * step with a writer that commits on a timer (seen in the test on Windows). Calibre's commits
 * take milliseconds.
 */
function busyPauseMs(): number {
  return 1 + Math.floor(Math.random() * 5);
}
/** How long a backup's first step waits for Calibre's commit before it is refused (ms). */
const STEP_LOCK_WAIT_MS = 200;
const pauseCell = new Int32Array(new SharedArrayBuffer(4));

/** Sleeps this thread (the copy's own worker thread; never the server's main thread). */
function pause(ms: number): void {
  Atomics.wait(pauseCell, 0, 0, ms);
}

/**
 * The next step's pages: what the last step's pace says fits in half of `maxLockMs` (half: a
 * cold page can take longer than the ones before it), at most double the last step.
 */
export function nextStepPages(lastPages: number, lastMs: number, maxLockMs: number): number {
  const perPage = Math.max(lastMs, 0.05) / Math.max(lastPages, 1);
  const fits = Math.floor(maxLockMs / 2 / perPage);
  return Math.max(MIN_STEP_PAGES, Math.min(fits, lastPages * 2, MAX_STEP_PAGES));
}

function sha256Sync(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The SQLite header: its file change counter is at offset 24. */
const HEADER_BYTES = 100;

/** True when Calibre has a journal (or WAL) file next to metadata.db: it is mid-write. */
function journalPresent(source: string): boolean {
  return fs.existsSync(`${source}-journal`) || fs.existsSync(`${source}-wal`);
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

function removeCopy(tmp: string): void {
  for (const suffix of ['', '-journal']) {
    try {
      fs.unlinkSync(`${tmp}${suffix}`);
    } catch {
      // not there
    }
  }
}

/**
 * One read of the whole file without any lock. True when the copy is a state Calibre
 * committed: no journal before or after, and the header (with its change counter) and the
 * size unchanged from before the first byte to after the last. A commit in between changes the
 * counter; a write still going on at the end has its journal there; a write that began before
 * the start had its journal there then.
 */
export function copyWithoutLock(source: string, tmp: string): boolean {
  if (journalPresent(source)) return false;
  const fd = fs.openSync(source, 'r');
  let out = -1;
  try {
    const before = readAt(fd, HEADER_BYTES, 0);
    const sizeBefore = fs.fstatSync(fd).size;
    if (before.length < HEADER_BYTES) return false;
    out = fs.openSync(tmp, 'w');
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      fs.writeSync(out, buf, 0, n);
      pos += n;
    }
    fs.closeSync(out);
    out = -1;
    const after = readAt(fd, HEADER_BYTES, 0);
    const sizeAfter = fs.fstatSync(fd).size;
    if (journalPresent(source)) return false;
    if (!before.equals(after) || sizeBefore !== sizeAfter || pos !== sizeBefore) return false;
    // The copy's own first page is the state read before (not one read part-way through).
    const copied = fs.openSync(tmp, 'r');
    try {
      return readAt(copied, HEADER_BYTES, 0).equals(before);
    } finally {
      fs.closeSync(copied);
    }
  } finally {
    if (out >= 0) fs.closeSync(out);
    fs.closeSync(fd);
  }
}

type BackupOutcome = { done: true } | { done: false; why: string };
type BackupStats = { steps: number; restarts: number; lockMs: number; busySteps: number };

const START_REFUSED = 'Calibre was committing as the copy began';

/**
 * One SQLite backup in steps that each hold the read lock about `maxLockMs` at most. Given up
 * (lock released, copy removed) after `maxRestarts` restarts or past `deadline`. A start
 * refused because Calibre was committing is begun again a moment later.
 */
async function shortLockBackup(
  job: SnapshotJob,
  deadline: number,
  stats: BackupStats,
): Promise<BackupOutcome> {
  for (;;) {
    const outcome = await backupOnce(job, deadline, stats);
    if (outcome.done || outcome.why !== START_REFUSED || Date.now() >= deadline) return outcome;
  }
}

async function backupOnce(
  job: SnapshotJob,
  deadline: number,
  stats: BackupStats,
): Promise<BackupOutcome> {
  const src = openSourceDatabase(job.source);
  // While Calibre commits, a step can't take the read lock (measured with better-sqlite3
  // 12.11.1, 2026-11-28): the first step waits for it up to busy_timeout (SQLite's default
  // 5 s) and, refused, reports 0 pages in all; a later step never waits and, refused, copies
  // nothing. So the first step waits only briefly, and a refused step is tried again a moment
  // later. Neither holds the lock while refused, so neither counts toward lockMs.
  src.pragma(`busy_timeout = ${STEP_LOCK_WAIT_MS}`);
  let last = Infinity;
  let restarts = 0;
  let pages = 0; // the step that just ran (SQLite's first step copies no page)
  let stepFrom = Date.now();
  try {
    const end = await src.backup(job.tmp, {
      progress: ({ remainingPages }) => {
        // Each step holds the read lock only while it runs (SQLite releases it before the
        // step returns): the time since the last callback is that step.
        const stepMs = Date.now() - stepFrom;
        stats.steps += 1;
        const restarted = remainingPages > last;
        if (restarted) {
          restarts += 1;
          stats.restarts += 1;
        }
        const copied = restarted || last === Infinity ? pages : last - remainingPages;
        last = remainingPages;
        if (restarts >= job.maxRestarts)
          throw new GiveUp(`Calibre wrote between two steps ${restarts} times`);
        if (Date.now() >= deadline) throw new GiveUp('out of time');
        if (pages === 0) {
          // SQLite's first step copies no page: it only waited for and checked the lock.
          pages = job.firstStepPages;
          stepFrom = Date.now();
          return pages;
        }
        if (copied === 0) {
          // The lock was not free (Calibre is committing): no lock was held; wait a moment.
          stats.busySteps += 1;
          pause(busyPauseMs());
          stepFrom = Date.now();
          return pages;
        }
        stats.lockMs = Math.max(stats.lockMs, stepMs);
        pages = nextStepPages(copied, stepMs, job.maxLockMs);
        stepFrom = Date.now();
        return pages;
      },
    });
    // A first step refused (Calibre committing) reports 0 pages remaining before SQLite knows
    // the page count, and better-sqlite3 ends the backup as if done, deleting the unfinished
    // copy: that is a refused try, not a copy (Linux test, 2026-11-28).
    if (end.totalPages === 0 || !fs.existsSync(job.tmp)) {
      stats.busySteps += 1;
      removeCopy(job.tmp);
      pause(busyPauseMs());
      return { done: false, why: START_REFUSED };
    }
    stats.lockMs = Math.max(stats.lockMs, Date.now() - stepFrom);
    return { done: true };
  } catch (err) {
    removeCopy(job.tmp);
    if (err instanceof GiveUp) return { done: false, why: err.message };
    // A lock refused where better-sqlite3 throws (opening): this backup is given up, not the copy.
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((err as Error)?.message)))
      return { done: false, why: 'Calibre held its write lock' };
    throw err;
  } finally {
    src.close();
  }
}

export async function runSnapshotJob(job: SnapshotJob): Promise<SnapshotJobResult> {
  const started = Date.now();
  const deadline = started + job.budgetMs;
  const stats: BackupStats = { steps: 0, restarts: 0, lockMs: 0, busySteps: 0 };
  let lockFree = false;
  let lockFreeTries = 0;
  let readMs = 0;
  let backups = 0;
  let copied = false;
  let why = '';
  // Rounds of plain reads, then one short-lock backup, until a copy is made or the budget is
  // spent (the first round always runs whole).
  for (let round = 0; !copied && (round === 0 || Date.now() < deadline); round++) {
    for (let i = 0; !copied && i < job.lockFreeTries; i++) {
      if (round > 0 && Date.now() >= deadline) break;
      const from = Date.now();
      lockFreeTries += 1;
      try {
        lockFree = copyWithoutLock(job.source, job.tmp);
      } catch {
        // An unreadable file: SQLite's backup below reports it properly.
        lockFree = false;
      }
      readMs += Date.now() - from;
      if (lockFree) copied = true;
      else removeCopy(job.tmp);
    }
    if (copied || (round > 0 && Date.now() >= deadline)) break;
    backups += 1;
    try {
      const outcome = await shortLockBackup(job, Math.max(deadline, Date.now() + 1), stats);
      if (outcome.done) copied = true;
      else why = outcome.why;
    } catch (err) {
      return { ok: false, kind: 'error', message: (err as Error).message ?? String(err) };
    }
  }
  if (!copied) {
    const secs = Math.round((Date.now() - started) / 1000);
    return {
      ok: false,
      kind: 'postponed',
      message:
        `Calibre kept writing metadata.db: ${lockFreeTries} lock-free read(s) and ${backups} ` +
        `short-lock backup(s) in ${secs} s found it changed (last: ${why || 'changed during the read'})`,
      lockFreeTries,
      backups,
      lockMs: stats.lockMs,
    };
  }
  // Given-up backups count too: their steps held the lock as well.
  const { steps, restarts, lockMs } = stats;
  const copyMs = Date.now() - started;

  let libraryUuid: string;
  try {
    const copy = new Database(job.tmp, { readonly: true, fileMustExist: true });
    try {
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok')
        return {
          ok: false,
          kind: 'skipped',
          message: `the copy failed quick_check: ${String(check)}`,
        };
      const row = copy.prepare('SELECT uuid FROM library_id LIMIT 1').get() as
        | { uuid: string }
        | undefined;
      if (!row?.uuid)
        return { ok: false, kind: 'failed', message: 'metadata.db has no library_id' };
      libraryUuid = row.uuid;
    } finally {
      copy.close();
    }
  } catch (err) {
    return {
      ok: false,
      kind: 'failed',
      message: `metadata.db does not look like a Calibre library: ${(err as Error).message}`,
    };
  }
  const sha256 = job.hash ? sha256Sync(job.tmp) : null;
  return {
    ok: true,
    libraryUuid,
    sha256,
    steps,
    restarts,
    copyMs,
    checkMs: Date.now() - started - copyMs,
    lockFree,
    lockFreeTries,
    backups,
    readMs,
    lockMs,
  };
}

if (parentPort && workerData && (workerData as { snapshotJob?: SnapshotJob }).snapshotJob) {
  const port = parentPort;
  void runSnapshotJob((workerData as { snapshotJob: SnapshotJob }).snapshotJob).then(
    (result) => port.postMessage(result),
    (err) =>
      port.postMessage({
        ok: false,
        kind: 'error',
        message: (err as Error)?.message ?? String(err),
      } satisfies SnapshotJobResult),
  );
}
