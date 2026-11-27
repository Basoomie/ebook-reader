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
 * before Calibre's first page write until its commit. Only when Calibre wrote during every try
 * does SQLite's backup make the copy, from pages the plain reads just brought into memory, so
 * its lock is short; the longest time one step held it is reported (`lockMs`).
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { openSourceDatabase } from './source-fs';

export interface SnapshotJob {
  source: string;
  tmp: string;
  /** Copy everything after the first step in one go (one read lock for the whole copy). */
  oneStep: boolean;
  /** Pages per step when copying step by step. */
  stepPages: number;
  /** After this many restarts (the source changed between steps), copy the rest in one step. */
  maxRestarts: number;
  /** Also return the copy's SHA-256 (a cleanup batch's copy). */
  hash: boolean;
  /** Lock-free reads of the whole file tried before SQLite's backup (0 = the backup only). */
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
      /** Time spent on the lock-free reads (part of copyMs). */
      readMs: number;
      /** Longest time one backup step held metadata.db's read lock; 0 when lock-free. */
      lockMs: number;
    }
  | { ok: false; kind: 'skipped' | 'failed' | 'error'; message: string };

const CHUNK = 1 << 20;

/**
 * "Every page" for one backup step (better-sqlite3 takes 0..2^31-1, not SQLite's -1). Not the
 * pages remaining at the last step: a write just before the step restarts the copy, and a step
 * of the old remaining count then copies only part of it (found in this file's test).
 */
const ALL_PAGES = 0x7fffffff;

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

export async function runSnapshotJob(job: SnapshotJob): Promise<SnapshotJobResult> {
  const started = Date.now();
  let steps = 0;
  let restarts = 0;
  let last = Infinity;
  let lockFree = false;
  let lockFreeTries = 0;
  while (!lockFree && lockFreeTries < job.lockFreeTries) {
    lockFreeTries += 1;
    try {
      lockFree = copyWithoutLock(job.source, job.tmp);
    } catch {
      // An unreadable file: SQLite's backup below reports it properly.
      lockFree = false;
    }
    if (!lockFree) removeCopy(job.tmp);
  }
  const readMs = Date.now() - started;
  let lockMs = 0;
  if (!lockFree) {
    const src = openSourceDatabase(job.source);
    // Each backup step holds the read lock only while it runs (SQLite releases it before the
    // step returns); the time from the end of one progress call to the next is that step.
    let stepFrom = Date.now();
    try {
      await src.backup(job.tmp, {
        progress: ({ remainingPages }) => {
          lockMs = Math.max(lockMs, Date.now() - stepFrom);
          steps += 1;
          if (remainingPages > last) restarts += 1;
          last = remainingPages;
          stepFrom = Date.now();
          if (job.oneStep || restarts >= job.maxRestarts) return ALL_PAGES;
          return job.stepPages;
        },
      });
      lockMs = Math.max(lockMs, Date.now() - stepFrom);
    } catch (err) {
      return { ok: false, kind: 'error', message: (err as Error).message ?? String(err) };
    } finally {
      src.close();
    }
  }
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
