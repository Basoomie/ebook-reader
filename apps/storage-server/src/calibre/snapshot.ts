/**
 * Copies a Calibre metadata.db to the SSD cache with SQLite's online backup
 * API (design doc 4.1, risk R2). The indexer only ever reads the copy.
 *
 * The copy is accepted only if the source did not change while it was being
 * copied, no Calibre journal was present, and the copy passes quick_check.
 * This also covers Calibre writing from another machine over SMB, where
 * SQLite's file locks may not reach this process.
 *
 * The copy itself runs on a worker thread (snapshot-worker.ts, 2026-11-26): better-sqlite3
 * runs one backup step per turn of the calling thread's event loop, so on the server's busy
 * main thread a 165 MB copy took over 600 s while it takes about 2 s on a thread of its own.
 * The time limit stops the thread, not only the next step.
 *
 * Calibre's lock (2026-11-27, 2026-11-28): a copy first reads the file with plain reads, which
 * take no lock, and keeps that copy when Calibre committed nothing meanwhile; otherwise the
 * backup runs in steps that each hold the lock at most about CALIBRE_LOCK_MAX_SECONDS, and
 * when Calibre keeps writing for CALIBRE_COPY_TRY_SECONDS the copy is postponed
 * (SnapshotPostponed). Calibre waits at most 10 s for its database: a copy never makes it wait
 * long, whatever the disk does. See snapshot-worker.ts.
 */
import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { METADATA_DB, readHeader, SourceStat, statFile } from './source-fs';
import type { SnapshotJob, SnapshotJobResult } from './snapshot-worker';

/** Pages of a backup's first step (4 KiB pages: 1 MiB); later steps are sized from its pace. */
const FIRST_STEP_PAGES = 256;
/** A backup Calibre restarted this often (it wrote between two steps) is given up. */
const MAX_STEP_RESTARTS = 3;
/**
 * Lock-free reads tried before each backup (2026-11-27, snapshot-worker.ts): the first brings
 * the file into memory (17-39 s cold on the busy NAS), the next ones often take well under a
 * second and fall between two of Calibre's commits.
 */
const LOCK_FREE_TRIES = 3;
/** Calibre waits this long for its database before giving up (BUSY_TIMEOUT, calibre 9.18). */
export const CALIBRE_BUSY_TIMEOUT_MS = 10_000;

/** A copy that held metadata.db's lock longer than this is logged as a warning. */
let lockWarnMs = 5_000;
/** A backup step is sized to hold the lock at most about this long (CALIBRE_LOCK_MAX_SECONDS). */
let maxLockMs = 2_000;
/** How long one copy tries before it is postponed (CALIBRE_COPY_TRY_SECONDS). */
let tryBudgetMs = 120_000;
let warn: (message: string) => void = (m) => console.warn(m);

/** At start-up: CALIBRE_LOCK_WARN_SECONDS and where the warning goes. */
export function configureSnapshotLockWarning(
  seconds: number,
  log?: (message: string) => void,
): void {
  lockWarnMs = Math.round(seconds * 1000);
  if (log) warn = log;
}

/** At start-up: CALIBRE_LOCK_MAX_SECONDS and CALIBRE_COPY_TRY_SECONDS. */
export function configureSnapshotCopy(opts: { maxLockSeconds: number; trySeconds: number }): void {
  maxLockMs = Math.round(opts.maxLockSeconds * 1000);
  tryBudgetMs = Math.round(opts.trySeconds * 1000);
}

/** How a copy went, for the callers' log lines: "no lock" or "lock held 0.4 s at most". */
export function describeLock(result: { lockFree: boolean; lockMs: number }): string {
  if (result.lockMs === 0) return 'no lock';
  return `lock held ${(result.lockMs / 1000).toFixed(1)} s at most`;
}

// Under ts-node (dev, tests) the worker is TypeScript too.
const RUNNING_TS = path.extname(__filename) === '.ts';
const WORKER_FILE = path.join(__dirname, `snapshot-worker${RUNNING_TS ? '.ts' : '.js'}`);

/** A temporary reason not to snapshot now; the next poll retries. */
export class SnapshotSkipped extends Error {}

/**
 * Calibre kept writing for the whole try (or the copy ran out of time): the callers wait before
 * the next try, so repeated reads of a busy metadata.db don't slow Calibre's writes.
 */
export class SnapshotPostponed extends SnapshotSkipped {}

/** The wait before the next try after `postponed` copies in a row: 1, 2, 4, 8, then 10 min. */
export function postponedWaitMs(postponed: number): number {
  return Math.min(2 ** Math.max(postponed - 1, 0), 10) * 60_000;
}

/** The source can't be snapshotted as it is (e.g. WAL mode); reported as a library error. */
export class SnapshotFailed extends Error {}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

export function journalFiles(metadataDb: string): string[] {
  return [`${metadataDb}-journal`, `${metadataDb}-wal`];
}

/** True when Calibre has a journal or WAL file next to metadata.db (it is mid-write). */
export async function hasJournal(metadataDb: string): Promise<boolean> {
  for (const file of journalFiles(metadataDb)) {
    if (await statFile(file)) return true;
  }
  return false;
}

export function sameStat(a: SourceStat | null, b: SourceStat | null): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface SnapshotResult {
  /** stat of the source taken before the copy (identical after it). */
  sourceStat: SourceStat;
  /** Calibre's library UUID (library_id table). */
  libraryUuid: string;
  file: string;
  /** The copy's SHA-256, when asked for (`hash`). */
  sha256: string | null;
  /** How the copy went (for the log): backup steps, restarts and times in ms. */
  steps: number;
  restarts: number;
  copyMs: number;
  checkMs: number;
  /** The copy kept came from a plain read. */
  lockFree: boolean;
  /** Longest time one backup step held metadata.db's read lock (ms); 0 when none ran. */
  lockMs: number;
}

export interface SnapshotOptions {
  timeoutMs: number;
  /**
   * Accept a source that changed during the copy. SQLite's backup restarts by itself when the
   * source changes, so the copy is still consistent; only use when the source never settles.
   */
  allowChanging?: boolean;
  /** Also compute the copy's SHA-256 on the worker thread (a cleanup batch's copy). */
  hash?: boolean;
  /** Lock-free reads tried before each backup (default 3; 0 = the backup only). */
  lockFreeTries?: number;
  /**
   * The longest a backup step should hold the lock (default CALIBRE_LOCK_MAX_SECONDS). There
   * is no one-step copy any more (2026-11-28): it held the lock for as long as the disk took.
   */
  maxLockMs?: number;
  /** How long to try before SnapshotPostponed (default CALIBRE_COPY_TRY_SECONDS). */
  budgetMs?: number;
}

async function removeQuietly(file: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await fs.unlink(`${file}${suffix}`).catch(() => {});
  }
}

/** Temporary copies left behind (a stopped server) are removed once they are this old. */
const STALE_TMP_MS = 60 * 60_000;
let tmpCounter = 0;

/** A temporary name of its own per copy: a stopped copy's thread may still hold its file. */
function tmpName(dest: string): string {
  tmpCounter += 1;
  return `${dest}.${process.pid}-${Date.now().toString(36)}-${tmpCounter}.tmp`;
}

/** Removes this copy's old temporary files (`<dest>.tmp` from before, or a stopped copy's). */
async function removeStaleTmps(dest: string): Promise<void> {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`) || !/.tmp(-journal|-wal|-shm)?$/.test(name)) continue;
    const file = path.join(dir, name);
    const st = await fs.stat(file).catch(() => null);
    if (name === `${base}.tmp` || (st && Date.now() - st.mtimeMs > STALE_TMP_MS))
      await fs.unlink(file).catch(() => {});
  }
}

/**
 * Runs one copy on its own worker thread. Past `timeoutMs` the caller gets SnapshotSkipped at
 * once and the thread is stopped; its temporary file is removed once it has stopped (a native
 * step in progress finishes first).
 */
function runInWorker(job: SnapshotJob, timeoutMs: number): Promise<SnapshotJobResult> {
  return new Promise((resolve, reject) => {
    const workerData = { snapshotJob: job };
    const worker = RUNNING_TS
      ? new Worker(
          `require('ts-node/register/transpile-only'); require(${JSON.stringify(WORKER_FILE)});`,
          { eval: true, workerData },
        )
      : new Worker(WORKER_FILE, { workerData });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => {
        finish(() =>
          reject(
            new SnapshotPostponed(`the copy took longer than ${Math.round(timeoutMs / 1000)} s`),
          ),
        );
        void worker
          .terminate()
          .catch(() => {})
          .then(() => removeQuietly(job.tmp));
      },
      Math.max(timeoutMs, 0),
    );
    worker.once('message', (result: SnapshotJobResult) => finish(() => resolve(result)));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`the copy's worker stopped (exit code ${code})`))),
    );
  });
}

export async function snapshotMetadataDb(
  source: string,
  dest: string,
  {
    timeoutMs,
    allowChanging = false,
    hash = false,
    lockFreeTries = LOCK_FREE_TRIES,
    maxLockMs: stepLockMs = maxLockMs,
    budgetMs = tryBudgetMs,
  }: SnapshotOptions,
): Promise<SnapshotResult> {
  const before = await statFile(source);
  if (!before) throw new SnapshotSkipped(`${METADATA_DB} is not there`);
  if (await hasJournal(source)) {
    throw new SnapshotSkipped('Calibre is writing (a journal file is present)');
  }

  const header = await readHeader(source);
  if (header.length < 100 || header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    throw new SnapshotFailed(`${METADATA_DB} is not a SQLite database`);
  }
  if (header[18] === 2 || header[19] === 2) {
    throw new SnapshotFailed(
      `${METADATA_DB} is in WAL mode, which can't be read safely from a read-only mount`,
    );
  }

  await removeStaleTmps(dest);
  const tmp = tmpName(dest);
  try {
    const result = await runInWorker(
      {
        source,
        tmp,
        maxLockMs: stepLockMs,
        firstStepPages: FIRST_STEP_PAGES,
        maxRestarts: MAX_STEP_RESTARTS,
        // Room left for quick_check and the checksum inside the time limit.
        budgetMs: Math.max(0, Math.min(budgetMs, timeoutMs * 0.75)),
        hash,
        lockFreeTries,
      },
      timeoutMs,
    );
    if ((result.ok || result.kind === 'postponed') && result.lockMs > lockWarnMs) {
      warn(
        `Calibre: copying ${source} held its database lock for ${(result.lockMs / 1000).toFixed(1)} s ` +
          `in one step (Calibre gives up after ${CALIBRE_BUSY_TIMEOUT_MS / 1000} s; steps are sized ` +
          `for ${stepLockMs / 1000} s, CALIBRE_LOCK_MAX_SECONDS; warning above ${lockWarnMs / 1000} s, ` +
          `CALIBRE_LOCK_WARN_SECONDS)`,
      );
    }
    if (!result.ok) {
      if (result.kind === 'postponed') throw new SnapshotPostponed(result.message);
      if (result.kind === 'skipped') throw new SnapshotSkipped(result.message);
      if (result.kind === 'failed') throw new SnapshotFailed(result.message);
      throw new Error(result.message);
    }

    const after = await statFile(source);
    if (!allowChanging && (!sameStat(before, after) || (await hasJournal(source)))) {
      throw new SnapshotSkipped(`${METADATA_DB} changed during the copy`);
    }

    await fs.rename(tmp, dest);
    return {
      sourceStat: before,
      libraryUuid: result.libraryUuid,
      file: dest,
      sha256: result.sha256,
      steps: result.steps,
      restarts: result.restarts,
      copyMs: result.copyMs,
      checkMs: result.checkMs,
      lockFree: result.lockFree,
      lockMs: result.lockMs,
    };
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}
