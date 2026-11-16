/**
 * Stage 3 (WP20c): the reader processes (book-text-child, in src/counts like the counter: the
 * cleanup module itself never starts a process) and the requests sent to them, one
 * at a time per process; a pool of `size` processes reads that many books at once. A
 * timeout or a crash becomes the request's outcome and the process is replaced; nothing
 * here throws for a book.
 */
import { ChildProcess, fork } from 'child_process';
import os from 'os';
import path from 'path';
import type {
  CompareResult,
  IndexRequest,
  IndexResult,
  Stage3ChildMessage,
  Stage3Request,
  TextResult,
} from './book-text-child';
import { doWork, type BookTextModule } from '../cleanup/stage3-work';

export type Outcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; stopped?: boolean };

/** What the analysis needs from the reader processes (a stand-in in tests). */
export interface Stage3Reader {
  text(file: string): Promise<Outcome<TextResult>>;
  compare(
    books: { key: number; file: string }[],
    pairs: [number, number][],
    extra: { minRun: number; minContext: number },
  ): Promise<Outcome<CompareResult>>;
  index(req: Omit<IndexRequest, 'id' | 'type'>): Promise<Outcome<IndexResult>>;
  close(): void;
}

export interface Stage3WorkerOptions {
  bundle: string;
  importOptions: unknown;
  /** Per book read (a compare request gets this per book it reads). */
  timeoutMs: () => number;
  maxMemoryMb?: number;
  nice?: number;
  startTimeoutMs?: number;
  /** Requests per process before it is replaced (jsdom keeps memory). */
  requestsPerProcess?: number;
  log?: (m: string) => void;
}

const RUNNING_TS = path.extname(__filename) === '.ts';
const CHILD_SCRIPT = path.join(__dirname, `book-text-child${RUNNING_TS ? '.ts' : '.js'}`);
const CHILD_EXEC_ARGV = RUNNING_TS ? ['-r', 'ts-node/register/transpile-only'] : [];
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const STDERR_TAIL = 2000;
/** The index of the whole library (a sort of every sample): minutes at most. */
const INDEX_TIMEOUT_MS = 30 * 60 * 1000;

class OneReader {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private pending: {
    id: number;
    child: ChildProcess;
    timer: NodeJS.Timeout;
    resolve: (o: Outcome<unknown>) => void;
  } | null = null;
  private served = 0;
  private nextId = 1;
  private stderr = '';
  closed = false;
  busy = false;

  constructor(private readonly opts: Stage3WorkerOptions) {}

  async request<T>(make: (id: number) => Stage3Request, timeoutMs: number): Promise<Outcome<T>> {
    if (this.closed) return { ok: false, code: 'stopped', message: 'stopped', stopped: true };
    if (this.child && this.served >= (this.opts.requestsPerProcess ?? 200)) this.kill();
    let child: ChildProcess;
    try {
      child = await this.start();
    } catch (err) {
      return { ok: false, code: 'start_failed', message: (err as Error).message };
    }
    return new Promise<Outcome<T>>((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.settle(id, {
          ok: false,
          code: 'timeout',
          message: `no result after ${Math.round(timeoutMs / 1000)} s`,
        });
        this.kill();
      }, timeoutMs);
      this.pending = { id, child, timer, resolve: resolve as (o: Outcome<unknown>) => void };
      this.served++;
      child.send(make(id));
    });
  }

  close(): void {
    this.closed = true;
    if (this.pending) {
      this.settle(this.pending.id, {
        ok: false,
        code: 'stopped',
        message: 'stopped',
        stopped: true,
      });
    }
    this.kill();
  }

  private settle(id: number, outcome: Outcome<unknown>): void {
    const p = this.pending;
    if (!p || p.id !== id) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(outcome);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.served = 0;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.stderr = '';
    const child = fork(CHILD_SCRIPT, [this.opts.bundle], {
      execArgv: [...CHILD_EXEC_ARGV, `--max-old-space-size=${this.opts.maxMemoryMb ?? 2048}`],
      cwd: SERVER_ROOT,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    try {
      if (child.pid) os.setPriority(child.pid, this.opts.nice ?? 10);
    } catch {
      // A lower priority is a nicety only.
    }
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    const starting = new Promise<ChildProcess>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => fail('the reader process did not start in time'),
        this.opts.startTimeoutMs ?? 120_000,
      );
      const fail = (message: string) => {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (this.child === child) this.child = null;
        if (this.starting === starting) this.starting = null;
        reject(new Error(message));
      };
      child.on('message', (m: Stage3ChildMessage) => {
        if (m.type === 'ready') {
          ready = true;
          clearTimeout(timer);
          this.child = child;
          this.starting = null;
          resolve(child);
        } else if (m.type === 'fatal') {
          fail(m.message);
        } else if (m.type === 'result') {
          this.settle(
            m.id,
            m.ok ? { ok: true, data: m.data } : { ok: false, code: m.code, message: m.message },
          );
        }
      });
      child.on('error', (err) => {
        if (!ready) fail(`the reader process could not be started: ${err.message}`);
      });
      child.on('exit', (code, signal) => {
        const how = `${signal ? `signal ${signal}` : `code ${code}`}${
          this.stderr.trim() ? `: ${this.stderr.trim().split('\n').at(-1)!.slice(0, 300)}` : ''
        }`;
        if (!ready) {
          fail(`the reader process exited while starting (${how})`);
          return;
        }
        if (this.child === child) {
          this.child = null;
          this.served = 0;
        }
        if (this.pending?.child === child) {
          this.settle(this.pending.id, {
            ok: false,
            code: 'crashed',
            message: `the reader process exited (${how})`,
          });
        }
      });
    });
    this.starting = starting;
    return starting;
  }
}

/** A pool of reader processes; each request goes to a free one. */
export class Stage3Worker implements Stage3Reader {
  private readers: OneReader[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly opts: Stage3WorkerOptions,
    private size: number,
  ) {}

  /** Changes the number of processes (from the settings) for later requests. */
  resize(size: number): void {
    this.size = Math.max(1, size);
  }

  private async acquire(): Promise<OneReader> {
    for (;;) {
      if (this.closed) {
        const dead = new OneReader(this.opts);
        dead.closed = true;
        return dead;
      }
      this.readers = this.readers.filter((r) => !r.closed);
      const free = this.readers.find((r) => !r.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      if (this.readers.length < this.size) {
        const r = new OneReader(this.opts);
        r.busy = true;
        this.readers.push(r);
        return r;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private release(r: OneReader): void {
    r.busy = false;
    if (this.readers.filter((x) => !x.closed).length > this.size) {
      r.close();
    }
    this.waiters.shift()?.();
  }

  async text(file: string): Promise<Outcome<TextResult>> {
    const r = await this.acquire();
    try {
      return await r.request<TextResult>(
        (id) => ({ id, type: 'text', file, options: this.opts.importOptions }),
        this.opts.timeoutMs(),
      );
    } finally {
      this.release(r);
    }
  }

  async compare(
    books: { key: number; file: string }[],
    pairs: [number, number][],
    extra: { minRun: number; minContext: number },
  ): Promise<Outcome<CompareResult>> {
    const r = await this.acquire();
    try {
      return await r.request<CompareResult>(
        (id) => ({
          id,
          type: 'compare',
          books,
          pairs,
          options: this.opts.importOptions,
          ...extra,
        }),
        this.opts.timeoutMs() * Math.max(1, books.length),
      );
    } finally {
      this.release(r);
    }
  }

  async index(req: Omit<IndexRequest, 'id' | 'type'>): Promise<Outcome<IndexResult>> {
    const r = await this.acquire();
    try {
      return await r.request<IndexResult>(
        (id) => ({ id, type: 'index', ...req }),
        INDEX_TIMEOUT_MS,
      );
    } finally {
      this.release(r);
    }
  }

  close(): void {
    this.closed = true;
    for (const r of this.readers) r.close();
    this.readers = [];
    for (const w of this.waiters.splice(0)) w();
  }
}

/**
 * The same work in this process (tests, with the real counter bundle loaded once): no
 * processes, no time limit.
 */
export class InProcessReader implements Stage3Reader {
  constructor(
    private readonly mod: BookTextModule,
    private readonly importOptions: unknown,
  ) {}

  private async run<T>(req: Stage3Request): Promise<Outcome<T>> {
    const r = await doWork(this.mod, req);
    return r.ok ? { ok: true, data: r.data as T } : r;
  }

  text(file: string): Promise<Outcome<TextResult>> {
    return this.run({ id: 0, type: 'text', file, options: this.importOptions });
  }

  compare(
    books: { key: number; file: string }[],
    pairs: [number, number][],
    extra: { minRun: number; minContext: number },
  ): Promise<Outcome<CompareResult>> {
    return this.run({
      id: 0,
      type: 'compare',
      books,
      pairs,
      options: this.importOptions,
      ...extra,
    });
  }

  index(req: Omit<IndexRequest, 'id' | 'type'>): Promise<Outcome<IndexResult>> {
    return this.run({ id: 0, type: 'index', ...req });
  }

  close(): void {}
}
