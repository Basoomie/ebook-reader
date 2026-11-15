/**
 * Runs the pronunciation fixes (Season 2 Phase 12) off the main thread, like the library's
 * /regex/ searches (catalog/search-runner.ts, WP7a): a JavaScript pattern such as
 * /(a+)+$/ can take forever on one sentence, and a stuck main thread would stop position
 * sync and book downloads. One long-lived worker thread; past the time limit
 * (PRONUNCIATION_REGEX_TIMEOUT_SECONDS, for one whole book) it is terminated (and started
 * again for the next run) and the caller gets FixTimeoutError naming the entry that was
 * running. Runs one at a time, in order.
 */
import path from 'path';
import { Worker } from 'worker_threads';
import type { FixEntry, FixSentence, SentenceResult } from './fix-rules';

export class FixTimeoutError extends Error {
  constructor(
    readonly entryId: number | null,
    readonly seconds: number,
  ) {
    super(`Applying the pronunciation fixes took longer than ${seconds} s`);
  }
}

export interface FixRunnerOptions {
  timeoutSeconds: number;
  logError?: (message: string, err?: unknown) => void;
}

interface Pending {
  resolve: (results: SentenceResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  entryId: number | null;
}

// Under ts-node (dev, tests) the worker is TypeScript too.
const RUNNING_TS = path.extname(__filename) === '.ts';
const WORKER_FILE = path.join(__dirname, `fix-worker${RUNNING_TS ? '.ts' : '.js'}`);

export class FixRunner {
  private worker: Worker | null = null;
  /** Resolves once the worker has loaded (its start-up doesn't count against the limit). */
  private ready: Promise<Worker> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: FixRunnerOptions) {}

  get timeoutSeconds(): number {
    return this.opts.timeoutSeconds;
  }

  /** Applies `entries` to `sentences` (one result per sentence, same order). */
  apply(entries: FixEntry[], sentences: FixSentence[]): Promise<SentenceResult[]> {
    if (!entries.length) return Promise.resolve(sentences.map(() => ({ hits: [], skipped: [] })));
    // One at a time: the time limit is for this run only, not for waiting behind another.
    const run = this.queue.then(() => this.run(entries, sentences));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopWorker(new Error('the pronunciation fix runner is closed'));
  }

  private async run(entries: FixEntry[], sentences: FixSentence[]): Promise<SentenceResult[]> {
    if (this.closed) throw new Error('the pronunciation fix runner is closed');
    const worker = await this.ensureWorker();
    const id = this.nextId++;
    return new Promise<SentenceResult[]>((resolve, reject) => {
      const timer = setTimeout(() => this.timeout(id), this.opts.timeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timer, entryId: null });
      worker.postMessage({
        id,
        entries,
        sentences: sentences.map((s) => ({ text: s.text, reading: s.reading, ruby: s.ruby })),
      });
    });
  }

  private ensureWorker(): Promise<Worker> {
    if (this.ready) return this.ready;
    const worker = RUNNING_TS
      ? new Worker(
          `require('ts-node/register/transpile-only'); require(${JSON.stringify(WORKER_FILE)});`,
          { eval: true },
        )
      : new Worker(WORKER_FILE);
    worker.unref();
    let started: (w: Worker) => void = () => undefined;
    let failed: (err: Error) => void = () => undefined;
    const ready = new Promise<Worker>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    ready.catch(() => undefined);
    worker.on(
      'message',
      (msg: {
        ready?: boolean;
        id?: number;
        entryId?: number;
        results?: SentenceResult[];
        error?: string;
      }) => {
        if (msg.ready) started(worker);
        if (msg.id === undefined) return;
        const job = this.pending.get(msg.id);
        if (!job) return;
        if (msg.entryId !== undefined) {
          job.entryId = msg.entryId;
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(job.timer);
        if (msg.error !== undefined) job.reject(new Error(msg.error));
        else job.resolve(msg.results ?? []);
      },
    );
    worker.on('error', (err) => {
      this.opts.logError?.('the pronunciation fix worker failed', err);
      failed(err);
      if (this.worker === worker) void this.stopWorker(err);
    });
    worker.on('exit', () => {
      failed(new Error('the pronunciation fix worker stopped'));
      if (this.worker === worker) {
        this.worker = null;
        this.ready = null;
        this.failAll(() => new Error('the pronunciation fix worker stopped'));
      }
    });
    this.worker = worker;
    this.ready = ready;
    return ready;
  }

  private timeout(id: number): void {
    const entryId = this.pending.get(id)?.entryId ?? null;
    void this.stopWorker(new FixTimeoutError(entryId, this.opts.timeoutSeconds));
  }

  private failAll(err: () => Error): void {
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(err());
      this.pending.delete(id);
    }
  }

  private async stopWorker(err: Error): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.failAll(() => err);
    if (worker) await worker.terminate();
  }
}
