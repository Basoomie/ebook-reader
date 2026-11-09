/**
 * One counter process (count-child) and the requests sent to it, one book at a time.
 * Never throws for a book: a timeout, a crash or a bad EPUB becomes an outcome.
 * Only a counter that cannot start at all throws (CounterStartError): that is a
 * problem with the server, not with a book, so no book is blamed for it.
 */
import { ChildProcess, fork } from 'child_process';
import os from 'os';
import path from 'path';
import type { CountImportOptions } from './counter-bundle';

export type CountErrorCode = 'file_missing' | 'read_error' | 'bad_epub' | 'timeout' | 'crashed';

/** Parent -> child. */
export interface ChildRequest {
  id: number;
  file: string;
  options: CountImportOptions;
}

/** Child -> parent. */
export type ChildMessage =
  | { type: 'ready'; version: number }
  | { type: 'fatal'; message: string }
  | {
      type: 'result';
      id: number;
      ok: true;
      characters: number;
      bytesRead: number;
      durationMs: number;
    }
  | { type: 'result'; id: number; ok: false; code: CountErrorCode; message: string };

export type CountOutcome =
  | { ok: true; characters: number; bytesRead: number; durationMs: number }
  | { ok: false; code: CountErrorCode; message: string; durationMs: number }
  /** The worker was closed while counting (server shutting down): record nothing. */
  | { ok: false; code: 'stopped'; message: string; durationMs: number };

export class CounterStartError extends Error {}

export interface CountWorkerOptions {
  counterFile: string;
  /** The version the bundle header announces; the loaded counter must report the same. */
  expectedVersion: number;
  maxMemoryMb: number;
  nice: number;
  booksPerProcess: number;
  /** Per book. */
  timeoutMs: number;
  /** Until a new counter process reports ready. */
  startTimeoutMs: number;
  log?: (message: string) => void;
}

// Compiled server: dist/counts/count-child.js. Tests and `npm run dev` run the
// TypeScript sources, so the child needs ts-node too.
const RUNNING_TS = path.extname(__filename) === '.ts';
const CHILD_SCRIPT = path.join(__dirname, `count-child${RUNNING_TS ? '.ts' : '.js'}`);
const CHILD_EXEC_ARGV = RUNNING_TS ? ['-r', 'ts-node/register/transpile-only'] : [];
/** The server package (src/.. or dist/..), so the child resolves its modules there. */
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/** Last part of the child's stderr kept for crash messages (e.g. "heap out of memory"). */
const STDERR_TAIL = 2000;

interface Pending {
  id: number;
  /** The process this book was sent to (a replaced process must not settle the next book). */
  child: ChildProcess;
  started: number;
  timer: NodeJS.Timeout;
  resolve: (outcome: CountOutcome) => void;
}

export class CountWorker {
  private readonly opts: CountWorkerOptions;
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private pending: Pending | null = null;
  private booksInProcess = 0;
  private nextId = 1;
  private stderrTail = '';
  private closed = false;
  private warnedPriority = false;

  constructor(opts: CountWorkerOptions) {
    this.opts = opts;
  }

  /** Counts one EPUB. Throws only CounterStartError. */
  async count(file: string, options: CountImportOptions): Promise<CountOutcome> {
    if (this.closed) return stoppedOutcome(0);
    if (this.child && this.booksInProcess >= this.opts.booksPerProcess) this.kill();
    const child = await this.start();
    if (this.closed) return stoppedOutcome(0);
    return new Promise<CountOutcome>((resolve) => {
      const id = this.nextId++;
      const started = Date.now();
      const timer = setTimeout(() => {
        this.settle(id, {
          ok: false,
          code: 'timeout',
          message: `no result after ${Math.round(this.opts.timeoutMs / 1000)} s`,
          durationMs: Date.now() - started,
        });
        // The child may be stuck in a loop: replace it.
        this.kill();
      }, this.opts.timeoutMs);
      this.pending = { id, child, started, timer, resolve };
      this.booksInProcess++;
      const request: ChildRequest = { id, file, options };
      child.send(request);
    });
  }

  /** Stops the counter process. A count in progress resolves as 'stopped'. */
  close(): void {
    this.closed = true;
    if (this.pending) {
      this.settle(this.pending.id, stoppedOutcome(Date.now() - this.pending.started));
    }
    this.kill();
  }

  private settle(id: number, outcome: CountOutcome): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(outcome);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.booksInProcess = 0;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.stderrTail = '';
    const child = fork(CHILD_SCRIPT, [this.opts.counterFile], {
      execArgv: [...CHILD_EXEC_ARGV, `--max-old-space-size=${this.opts.maxMemoryMb}`],
      cwd: SERVER_ROOT,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.lowerPriority(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });

    const starting = new Promise<ChildProcess>((resolve, reject) => {
      let isReady = false;
      const startTimer = setTimeout(() => {
        fail(`the counter did not start within ${Math.round(this.opts.startTimeoutMs / 1000)} s`);
      }, this.opts.startTimeoutMs);
      const fail = (message: string) => {
        clearTimeout(startTimer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (this.child === child) this.child = null;
        if (this.starting === starting) this.starting = null;
        reject(new CounterStartError(message));
      };

      child.on('message', (message: ChildMessage) => {
        if (message.type === 'ready') {
          if (message.version !== this.opts.expectedVersion) {
            fail(
              `the counter reports version ${message.version} but its header says ` +
                `${this.opts.expectedVersion} (rebuild vendor/epub-count.cjs)`,
            );
            return;
          }
          isReady = true;
          clearTimeout(startTimer);
          this.child = child;
          this.starting = null;
          resolve(child);
        } else if (message.type === 'fatal') {
          fail(message.message);
        } else if (message.type === 'result') {
          if (message.ok) {
            this.settle(message.id, {
              ok: true,
              characters: message.characters,
              bytesRead: message.bytesRead,
              durationMs: message.durationMs,
            });
          } else {
            const started = this.pending?.started ?? Date.now();
            this.settle(message.id, {
              ok: false,
              code: message.code,
              message: message.message,
              durationMs: Date.now() - started,
            });
          }
        }
      });
      child.on('error', (err) => {
        if (!isReady) fail(`the counter could not be started: ${err.message}`);
      });
      child.on('exit', (code, signal) => {
        if (!isReady) {
          fail(
            `the counter exited while starting (${describeExit(code, signal, this.stderrTail)})`,
          );
          return;
        }
        if (this.child === child) {
          this.child = null;
          this.booksInProcess = 0;
        }
        if (this.pending?.child === child) {
          this.settle(this.pending.id, {
            ok: false,
            code: 'crashed',
            message: `the counter process exited (${describeExit(code, signal, this.stderrTail)})`,
            durationMs: Date.now() - this.pending.started,
          });
        }
      });
    });
    this.starting = starting;
    return starting;
  }

  private lowerPriority(child: ChildProcess): void {
    if (!child.pid || this.opts.nice <= 0) return;
    try {
      os.setPriority(child.pid, this.opts.nice);
    } catch (err) {
      if (!this.warnedPriority) {
        this.warnedPriority = true;
        this.opts.log?.(
          `Character counts: could not lower the counter's priority: ${(err as Error).message}`,
        );
      }
    }
  }
}

function stoppedOutcome(durationMs: number): CountOutcome {
  return { ok: false, code: 'stopped', message: 'stopped', durationMs };
}

function describeExit(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  const lines = stderr.trim().split('\n').filter(Boolean);
  const hint = lines.find((l) => /heap out of memory|Allocation failed/i.test(l)) ?? lines.at(-1);
  return hint ? `${how}: ${hint.trim().slice(0, 300)}` : how;
}
