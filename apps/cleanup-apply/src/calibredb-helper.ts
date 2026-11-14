/**
 * WP20b: one long-lived calibredb (helper/calibredb-helper.py, run by calibre-debug) for the
 * calls the sidecar makes most: `list`, and `set_metadata` for set_tags/set_fields. It runs
 * calibredb's own command code for the same argument lists (built and checked by
 * buildArgs), so a call does exactly what the `calibredb` program would, without calibre's
 * start-up per call.
 *
 * One call at a time. A call that was sent is never sent again, whatever happens (a write
 * may have happened): it fails like a calibredb that was stopped, and the worker's own
 * checks (look the book up, wait for Calibre) decide. Only when the helper can't START is the
 * call run with the `calibredb` program instead, and the helper is left alone for a while.
 */
import { spawn, type ChildProcess } from 'child_process';
import type { RunResult } from './calibredb';

export interface HelperOptions {
  /** calibre-debug (tests: node). */
  program: string;
  /** e.g. ['-e', '/app/helper/calibredb-helper.py']. */
  args: string[];
  /** How long the helper may take to start (ms). */
  startTimeoutMs?: number;
  /** After a failed start, plain calibredb is used for this long (ms). */
  retryAfterMs?: number;
  env?: Record<string, string>;
  log?: (message: string) => void;
}

/** The helper couldn't start: nothing was sent, the call may be run another way. */
export class HelperUnavailable extends Error {}

/** The helper stopped or timed out after the call was sent (it may have happened). */
export class HelperCallFailed extends Error {}

interface Pending {
  id: number;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const MARK = '@@ttsu ';

export class CalibredbHelper {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private buffer = '';
  private disabledUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** The calibre version the helper reported. */
  version: string | null = null;

  constructor(private readonly opts: HelperOptions) {}

  /** False while plain calibredb is used after a failed start. */
  usable(now = Date.now()): boolean {
    return now >= this.disabledUntil;
  }

  /** Runs one calibredb argument list (one at a time). */
  call(argv: string[], password: string, timeoutMs: number): Promise<RunResult> {
    const run = this.queue.then(() => this.callNow(argv, password, timeoutMs));
    this.queue = run.catch(() => {});
    return run;
  }

  stop(): void {
    this.kill(new HelperCallFailed('The calibredb helper was stopped'));
  }

  private async callNow(argv: string[], password: string, timeoutMs: number): Promise<RunResult> {
    if (!this.usable())
      throw new HelperUnavailable('The calibredb helper is resting after a failed start');
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new HelperUnavailable('The calibredb helper is not running');
    const id = this.nextId++;
    return new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill(
          new HelperCallFailed(`calibredb ${argv[0]} took longer than ${timeoutMs / 1000} s`)
        );
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      child.stdin!.write(`${JSON.stringify({ id, args: argv, password })}\n`);
    });
  }

  private start(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      let ready = false;
      const fail = (why: string) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        this.disabledUntil = Date.now() + (this.opts.retryAfterMs ?? 600_000);
        this.opts.log?.(`calibredb helper did not start (${why}); using calibredb for now`);
        child.kill('SIGKILL');
        this.child = null;
        reject(new HelperUnavailable(`The calibredb helper did not start: ${why}`));
      };
      const child = spawn(this.opts.program, this.opts.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.opts.env },
        windowsHide: true
      });
      const timer = setTimeout(() => fail('no answer'), this.opts.startTimeoutMs ?? 60_000);
      let stderr = '';
      child.stderr!.setEncoding('utf8').on('data', (d: string) => {
        stderr = (stderr + d).slice(-2000);
      });
      child.on('error', (err) => fail(err.message));
      child.on('exit', (code) => {
        if (!ready) {
          fail(`exit ${code}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
          return;
        }
        if (this.child === child) {
          this.child = null;
          this.failPending(new HelperCallFailed(`The calibredb helper stopped (exit ${code})`));
        }
      });
      child.stdin!.on('error', () => {});
      this.buffer = '';
      child.stdout!.setEncoding('utf8').on('data', (d: string) => {
        this.buffer += d;
        for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (!line.startsWith(MARK)) continue;
          let msg: { ready?: boolean; version?: string; id?: number } & Partial<RunResult>;
          try {
            msg = JSON.parse(line.slice(MARK.length));
          } catch {
            continue;
          }
          if (msg.ready && !ready) {
            ready = true;
            clearTimeout(timer);
            this.child = child;
            this.version = msg.version ?? null;
            this.opts.log?.(`calibredb helper running (calibre ${this.version ?? '?'})`);
            resolve();
            continue;
          }
          const p = this.pending;
          if (p && msg.id === p.id) {
            this.pending = null;
            clearTimeout(p.timer);
            p.resolve({ code: msg.code ?? 1, stdout: msg.stdout ?? '', stderr: msg.stderr ?? '' });
          }
        }
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private kill(err: Error): void {
    const child = this.child;
    this.child = null;
    this.failPending(err);
    child?.kill('SIGKILL');
  }
}
