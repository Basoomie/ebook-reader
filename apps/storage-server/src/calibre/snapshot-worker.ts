/**
 * The metadata.db copy's worker thread (2026-11-26). better-sqlite3 runs every backup step on
 * the thread that called it, one step per turn of that thread's event loop; on the server's
 * busy main thread (seconds per turn on the NAS) a 165 MB copy in 100-page steps took longer
 * than 600 s, while the same copy took 1.9 s in an idle process. Here the copy, its
 * quick_check, the library_id read and (when asked) the SHA-256 of the copy run on a thread of
 * their own, so they take as long as the disk needs, never as long as the server is busy.
 *
 * Reads the source read-only (source-fs.ts); writes only the temporary copy it was given.
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

export async function runSnapshotJob(job: SnapshotJob): Promise<SnapshotJobResult> {
  const started = Date.now();
  let steps = 0;
  let restarts = 0;
  let last = Infinity;
  const src = openSourceDatabase(job.source);
  try {
    await src.backup(job.tmp, {
      progress: ({ remainingPages }) => {
        steps += 1;
        if (remainingPages > last) restarts += 1;
        last = remainingPages;
        if (job.oneStep || restarts >= job.maxRestarts) return ALL_PAGES;
        return job.stepPages;
      },
    });
  } catch (err) {
    return { ok: false, kind: 'error', message: (err as Error).message ?? String(err) };
  } finally {
    src.close();
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
