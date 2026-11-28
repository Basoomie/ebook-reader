/**
 * Runs catalog queries that contain a /regex/ (WP7a). A JavaScript pattern such as
 * /(a+)+$/ can take forever on a single title, and a check inside the SQL function
 * can't interrupt one match; a stuck main thread would stop position sync and book
 * downloads, i.e. break reading. So these queries run in one long-lived worker thread
 * with its own read-only connection; past SEARCH_REGEX_TIMEOUT_SECONDS the thread is
 * terminated (and started again for the next search) and the caller gets
 * RegexTimeoutError. Queries without a pattern never come here.
 *
 * Without a database file (in-memory test databases) queries run on the given
 * connection, unprotected.
 *
 * It also works out the series and author figures (series-figures.ts `figures`): a read of the
 * whole library that would hold the main thread for a second or two on the NAS.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { Worker } from 'worker_threads';
import { registerRegexp } from './regexp';
import { computeFigures, type FiguresAnswer, type FiguresJob } from './series-figures';

export class RegexTimeoutError extends Error {}

export interface SearchRunnerOptions {
  /** The main connection (used when there is no file to open). */
  db: Database.Database;
  /** Database file for the worker's read-only connection; null = run in-process. */
  file: string | null;
  timeoutSeconds: number;
  logError?: (message: string, err?: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// Under ts-node (dev, tests) the worker is TypeScript too.
const RUNNING_TS = path.extname(__filename) === '.ts';
const WORKER_FILE = path.join(__dirname, `search-worker${RUNNING_TS ? '.ts' : '.js'}`);
/** A figures job's own time limit (SearchRunner.figures). */
const FIGURES_TIMEOUT_MS = 60_000;

export class SearchRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly opts: SearchRunnerOptions) {
    if (!opts.file) registerRegexp(opts.db);
  }

  get timeoutMs(): number {
    return this.opts.timeoutSeconds * 1000;
  }

  all(sql: string, params: unknown[]): Promise<unknown[]> {
    if (!this.opts.file) {
      return Promise.resolve().then(() => this.opts.db.prepare(sql).all(...params));
    }
    if (this.closed) return Promise.reject(new Error('the search runner is closed'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => this.timeout(), this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.postMessage({ id, sql, params });
    });
  }

  /**
   * The series and author figures, worked out on the worker's connection. Its own time limit
   * (a busy NAS can take a few seconds; the search limit is for runaway patterns).
   */
  figures(job: FiguresJob, timeoutMs = FIGURES_TIMEOUT_MS): Promise<FiguresAnswer> {
    if (!this.opts.file) {
      return Promise.resolve().then(() => computeFigures(this.opts.db, job));
    }
    if (this.closed) return Promise.reject(new Error('the search runner is closed'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<FiguresAnswer>((resolve, reject) => {
      const timer = setTimeout(
        () => void this.stopWorker(new Error('working out the series figures took too long')),
        timeoutMs,
      );
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.postMessage({ id, figures: job });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopWorker(new Error('the search runner is closed'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerData = { file: this.opts.file };
    const worker = RUNNING_TS
      ? new Worker(
          `require('ts-node/register/transpile-only'); require(${JSON.stringify(WORKER_FILE)});`,
          { eval: true, workerData },
        )
      : new Worker(WORKER_FILE, { workerData });
    worker.unref();
    worker.on(
      'message',
      (msg: { id?: number; rows?: unknown[]; figures?: unknown; error?: string }) => {
        if (msg.id === undefined) return;
        const job = this.pending.get(msg.id);
        if (!job) return;
        this.pending.delete(msg.id);
        clearTimeout(job.timer);
        if (msg.error !== undefined) job.reject(new Error(msg.error));
        else job.resolve(msg.figures ?? msg.rows ?? []);
      },
    );
    worker.on('error', (err) => {
      this.opts.logError?.('the search worker failed', err);
      if (this.worker === worker) void this.stopWorker(err);
    });
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null;
        this.failAll(new Error('the search worker stopped'));
      }
    });
    this.worker = worker;
    return worker;
  }

  private timeout(): void {
    void this.stopWorker(
      new RegexTimeoutError(`the search took longer than ${this.opts.timeoutSeconds} s`),
    );
  }

  private failAll(err: Error): void {
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(err);
      this.pending.delete(id);
    }
  }

  private async stopWorker(err: Error): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(err);
    if (worker) await worker.terminate();
  }
}
