/**
 * Character counts (WP3b, design 4.2 and risk R1). A background pass counts each
 * Calibre EPUB with the reader's own import and counting code (the counter bundle)
 * and stores the result in books.char_count, so the library can show counts, series
 * totals and `chars:` filters. The reader never uses this count: its progress comes
 * from its own in-book count.
 *
 * - Newest books first, one book at a time by default, in separate lower-priority
 *   processes, optionally rate-limited. Resumable: char_counts holds the state.
 * - A book is counted again when its EPUB changes (Calibre last_modified, path or
 *   size) or when the spec changes (counting rules or import settings).
 * - A book that fails (bad EPUB, missing file, timeout, crash) is recorded as an
 *   error and tried again only when its source or the spec changes, or on
 *   `cli counts retry`.
 * - EPUBs are read through calibre/source-fs (read-only); images are never read.
 *   Nothing is written outside the database.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { resolveInside } from '../calibre/source-fs';
import type { UploadStore } from '../uploads/upload-store';
import { noteCatalogWrite } from '../catalog/catalog-version';
import type { CountsConfig } from '../config';
import {
  COUNTER_BUNDLE,
  CounterInfo,
  countImportOptions,
  countSpec,
  readCounterInfo,
} from './counter-bundle';
import {
  countSourceKey,
  CountSource,
  getCountRecord,
  PendingCursor,
  SQL_CURRENT,
} from './count-records';
import { CounterStartError, CountOutcome, CountWorker } from './count-worker';

export interface CharCountServiceOptions {
  db: Database.Database;
  calibreDir: string;
  config: CountsConfig;
  /** The counter bundle; tests pass a stand-in. */
  counterFile?: string;
  /** Uploaded EPUBs (WP7b); without it, uploads are recorded as file_missing. */
  uploads?: UploadStore | null;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const BACKGROUND_BATCH = 200;
const PROGRESS_LOG_EVERY = 1000;

export class CharCountService {
  readonly spec: string;
  readonly counter: CounterInfo;
  private readonly db: Database.Database;
  private readonly opts: CharCountServiceOptions;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private running = false;
  private stopped = false;
  private wakeRequested = false;
  private loop: Promise<void> | null = null;
  private nextStartAt = 0;
  private workers: CountWorker[] = [];
  private lastProblem: string | null = null;
  /** Books the background pass recorded since start (for logs and tests). */
  processed = 0;

  /** Throws when the counter bundle can't be read: the caller runs without counts. */
  constructor(opts: CharCountServiceOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.counter = readCounterInfo(opts.counterFile ?? COUNTER_BUNDLE);
    this.spec = countSpec(this.counter.version, opts.config);
  }

  /**
   * Books whose count is missing or out of date, newest first, starting after
   * `after` (keyset paging, so a full pass reads each book once). Failed counts with
   * an unchanged source and spec are not pending.
   */
  pending(limit: number, after?: PendingCursor): (CountSource & PendingCursor)[] {
    const cursor = after ?? { addedAt: Number.MAX_SAFE_INTEGER, bookId: '￿' };
    // Same plan as the thumbnail pass: walk books_added in order and stop at `limit`.
    return (
      this.db
        .prepare(
          `SELECT b.id AS book_id, b.added_at, s.kind, l.folder, s.file_path, s.file_size,
                  s.calibre_last_modified
             FROM books b INDEXED BY books_added
             CROSS JOIN book_sources s
               ON s.book_id = b.id AND s.kind IN ('calibre', 'upload') AND s.missing_at IS NULL
             JOIN libraries l ON l.id = s.library_id AND l.enabled = 1 AND l.available = 1
             LEFT JOIN char_counts c ON c.book_id = b.id
            WHERE s.file_path IS NOT NULL
              AND (b.added_at < @addedAt OR (b.added_at = @addedAt AND b.id < @bookId))
              AND NOT ${SQL_CURRENT}
            ORDER BY b.added_at DESC, b.id DESC LIMIT @limit`,
        )
        .all({ ...cursor, spec: this.spec, limit }) as {
        book_id: string;
        added_at: number;
        kind: 'calibre' | 'upload';
        folder: string;
        file_path: string;
        file_size: number | null;
        calibre_last_modified: number | null;
      }[]
    ).map((r) => ({
      bookId: r.book_id,
      addedAt: r.added_at,
      kind: r.kind,
      libraryFolder: r.folder,
      filePath: r.file_path,
      fileSize: r.file_size,
      lastModified: r.calibre_last_modified,
    }));
  }

  /** Starts (or nudges) the background pass. Cheap to call often. */
  wake(): void {
    if (!this.opts.config.background || this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    this.loop = this.runBackground()
      .catch((err) => this.logError('Character counts: background pass failed:', err))
      .finally(() => {
        this.running = false;
        if (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          this.wake();
        }
      });
  }

  /** Resolves when the current background pass (if any) has finished. */
  async idle(): Promise<void> {
    while (this.loop) {
      const current = this.loop;
      await current;
      if (this.loop === current) break;
    }
  }

  /** Stops the pass and the counter processes (a count in progress is dropped). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const worker of this.workers) worker.close();
    await this.idle();
  }

  private async waitForSlot(): Promise<void> {
    const perMinute = this.opts.config.perMinute;
    if (perMinute <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextStartAt);
    this.nextStartAt = start + 60_000 / perMinute;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  }

  /** Logs a pass-stopping problem once until it changes (the pass retries on every wake). */
  private reportProblem(message: string): void {
    if (message === this.lastProblem) return;
    this.lastProblem = message;
    this.logError(`Character counts: ${message}`);
  }

  private async runBackground(): Promise<void> {
    const config = this.opts.config;
    const options = countImportOptions(config);
    this.workers = Array.from(
      { length: config.concurrency },
      () =>
        new CountWorker({
          counterFile: this.counter.file,
          expectedVersion: this.counter.version,
          maxMemoryMb: config.maxMemoryMb,
          nice: config.nice,
          booksPerProcess: config.booksPerProcess,
          timeoutMs: config.timeoutSeconds * 1000,
          startTimeoutMs: config.startTimeoutSeconds * 1000,
          log: this.log,
        }),
    );
    const started = Date.now();
    // Shared by the worker loops below; `halt` pauses the pass (a server-side problem).
    const pass = { counted: 0, failed: 0, consecutiveFailures: 0, halt: null as string | null };
    let cursor: PendingCursor | undefined;
    try {
      while (!this.stopped && !pass.halt) {
        const batch = this.pending(BACKGROUND_BATCH, cursor);
        if (batch.length === 0) break;
        const last = batch[batch.length - 1];
        cursor = { addedAt: last.addedAt, bookId: last.bookId };
        const before = this.processed;
        const queue = [...batch];
        await Promise.all(
          this.workers.map(async (worker) => {
            while (!this.stopped && !pass.halt) {
              const src = queue.shift();
              if (!src) return;
              await this.waitForSlot();
              if (this.stopped || pass.halt) return;
              let outcome: CountOutcome;
              try {
                outcome = await this.countOne(worker, src, options);
              } catch (err) {
                if (!(err instanceof CounterStartError)) throw err;
                pass.halt = `the counter cannot start, counting paused until the next poll: ${err.message}`;
                return;
              }
              if (isStopped(outcome)) return;
              this.record(src, outcome);
              this.processed++;
              if (outcome.ok) {
                pass.counted++;
                pass.consecutiveFailures = 0;
                this.lastProblem = null;
              } else {
                pass.failed++;
                if (outcome.code === 'timeout' || outcome.code === 'crashed') {
                  pass.consecutiveFailures++;
                  if (pass.consecutiveFailures >= config.maxConsecutiveFailures) {
                    pass.halt =
                      `${pass.consecutiveFailures} books in a row timed out or crashed the ` +
                      `counter (last: ${outcome.message}); counting paused until the next poll`;
                  }
                } else {
                  pass.consecutiveFailures = 0;
                }
              }
              const done = pass.counted + pass.failed;
              if (done % PROGRESS_LOG_EVERY === 0) {
                this.log(`Character counts: ${done} books so far this pass`);
              }
            }
          }),
        );
        // A batch that recorded nothing (every write failed) must not spin.
        if (this.processed === before) break;
      }
    } finally {
      for (const worker of this.workers) worker.close();
      this.workers = [];
    }
    if (pass.halt) this.reportProblem(pass.halt);
    if (pass.counted + pass.failed > 0) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log(
        `Character counts: counted ${pass.counted}` +
          (pass.failed ? `, ${pass.failed} failed` : '') +
          ` in ${secs} s`,
      );
    }
  }

  /** Throws only CounterStartError. */
  private countOne(
    worker: CountWorker,
    src: CountSource,
    options: ReturnType<typeof countImportOptions>,
  ): Promise<CountOutcome> {
    let file: string;
    try {
      if (src.kind === 'upload') {
        if (!this.opts.uploads) throw new Error('uploads are not available');
        file = this.opts.uploads.resolve(src.filePath);
      } else {
        file = resolveInside(path.join(this.opts.calibreDir, src.libraryFolder), src.filePath);
      }
    } catch (err) {
      // A stored path that would leave the library folder: never opened.
      return Promise.resolve({
        ok: false,
        code: 'file_missing',
        message: (err as Error).message,
        durationMs: 0,
      });
    }
    return worker.count(file, options);
  }

  /** Stores one outcome and updates books.char_count in the same transaction. */
  private record(src: CountSource, outcome: RecordedOutcome): void {
    const key = countSourceKey(src);
    const previous = getCountRecord(this.db, src.bookId);
    const attempts = outcome.ok
      ? 0
      : (previous?.status === 'error' && previous.sourceKey === key && previous.spec === this.spec
          ? previous.attempts
          : 0) + 1;
    const characters = outcome.ok ? outcome.characters : null;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO char_counts (book_id, status, source_key, spec, characters, build,
             attempts, error_code, error, duration_ms, bytes_read, counted_at)
           VALUES (@bookId, @status, @key, @spec, @characters, @build, @attempts, @errorCode,
             @error, @durationMs, @bytesRead, @now)
           ON CONFLICT(book_id) DO UPDATE SET status = excluded.status,
             source_key = excluded.source_key, spec = excluded.spec,
             characters = excluded.characters, build = excluded.build,
             attempts = excluded.attempts, error_code = excluded.error_code,
             error = excluded.error, duration_ms = excluded.duration_ms,
             bytes_read = excluded.bytes_read, counted_at = excluded.counted_at`,
        )
        .run({
          bookId: src.bookId,
          status: outcome.ok ? 'ok' : 'error',
          key,
          spec: this.spec,
          characters,
          build: this.counter.build,
          attempts,
          errorCode: outcome.ok ? null : outcome.code,
          error: outcome.ok ? null : outcome.message,
          durationMs: outcome.durationMs,
          bytesRead: outcome.ok ? outcome.bytesRead : null,
          now: Date.now(),
        });
      this.db.prepare('UPDATE books SET char_count = ? WHERE id = ?').run(characters, src.bookId);
    })();
    noteCatalogWrite(this.db);
  }
}

type StoppedOutcome = Extract<CountOutcome, { code: 'stopped' }>;
type RecordedOutcome = Exclude<CountOutcome, StoppedOutcome>;

function isStopped(outcome: CountOutcome): outcome is StoppedOutcome {
  return !outcome.ok && outcome.code === 'stopped';
}
