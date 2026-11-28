/**
 * Looking up a Calibre book in the library's live metadata.db (read only, 2026-11-28).
 *
 * Found live 2026-11-28: while a manga move batch ran, the server's main thread spent 19 s of
 * every 90 s waiting on reads of the live metadata.db (the move's check of each book: two
 * whole-table searches by UUID, 6-10 s each on the NAS), so the health check went unanswered
 * and the apps showed the Library offline. Two changes, both here:
 *
 * - the book is found by its Calibre id first (live-book-read.ts), the UUID search only when
 *   the id doesn't name it;
 * - `lookupLiveBook` reads on a thread of its own, so however long the disk takes, the server
 *   keeps answering. `lookupLiveBookSync` is only for the few callers that must stay
 *   synchronous; give it the Calibre id.
 */
import path from 'path';
import { Worker } from 'worker_threads';
import { readLiveBook, type LiveBook, type LiveBookKey } from './live-book-read';
import { openSourceDatabase } from './source-fs';

export type { LiveBook, LiveBookKey } from './live-book-read';

/** How long Calibre's write lock is waited for (it holds it for milliseconds). */
const BUSY_TIMEOUT_MS = 3000;
/** A lookup not answered in this time fails, and the thread is started again. */
const LOOKUP_LIMIT_MS = 120_000;

const RUNNING_TS = path.extname(__filename) === '.ts';
const WORKER_FILE = path.join(__dirname, `live-book-worker${RUNNING_TS ? '.ts' : '.js'}`);

/** The book now, read on the calling thread. Throws when the database can't be read. */
export function lookupLiveBookSync(
  metadataDb: string,
  key: LiveBookKey,
  busyTimeoutMs = BUSY_TIMEOUT_MS,
): LiveBook | null {
  const db = openSourceDatabase(metadataDb);
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))}`);
    return readLiveBook(db, key);
  } finally {
    db.close();
  }
}

export interface LookupRequest {
  id: number;
  file: string;
  key: LiveBookKey;
  busyTimeoutMs: number;
}

export type LookupReply =
  | { id: number; ok: true; book: LiveBook | null }
  | { id: number; ok: false; message: string };

interface Pending {
  resolve: (book: LiveBook | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(err);
  }
}

function startWorker(): Worker {
  const w = RUNNING_TS
    ? new Worker(
        `require('ts-node/register/transpile-only'); require(${JSON.stringify(WORKER_FILE)});`,
        { eval: true },
      )
    : new Worker(WORKER_FILE);
  // Never keeps the process alive on its own (tests, shutdown).
  w.unref();
  w.on('message', (reply: LookupReply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.book);
    else p.reject(new Error(reply.message));
  });
  const gone = (err: Error) => {
    if (worker === w) worker = null;
    failAll(err);
  };
  w.on('error', (err) => gone(err));
  w.on('exit', (code) => gone(new Error(`the live lookup's thread stopped (exit code ${code})`)));
  return w;
}

/**
 * The book now, read on the lookup thread (one lookup at a time, in order). Rejects when the
 * database can't be read or the lookup takes longer than `limitMs`.
 */
export function lookupLiveBook(
  metadataDb: string,
  key: LiveBookKey,
  { busyTimeoutMs = BUSY_TIMEOUT_MS, limitMs = LOOKUP_LIMIT_MS } = {},
): Promise<LiveBook | null> {
  worker ??= startWorker();
  const w = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // A read that never ends (a hung mount): the thread is replaced; every lookup waiting
      // behind it fails now rather than later.
      const err = new Error(`the live lookup took longer than ${Math.round(limitMs / 1000)} s`);
      if (worker === w) worker = null;
      failAll(err);
      void w.terminate().catch(() => {});
    }, limitMs);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, file: metadataDb, key, busyTimeoutMs } satisfies LookupRequest);
  });
}
