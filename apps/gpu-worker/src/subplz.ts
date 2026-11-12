/**
 * Runs SubPlz exactly like the user's known-good manual runs (decided 2026-11-12, copied
 * from the SubPlz README, flags not tuned):
 *
 *   docker run --rm --gpus all -v <content>:/sync -v <cache>:/SyncCache <image> sync -d /sync/<book folder>
 *
 * The SubPlz part (`sync -d /sync/book`) has no extra flags. The one Docker-side addition
 * is `--name ttsu-subplz-<job>`: stopping the docker client alone leaves the container
 * running, so a stop runs `docker kill` on that name. It never touches other containers
 * (e.g. the user's own manual runs).
 */
import { type ChildProcess, execFile, spawn } from 'child_process';

export function containerName(jobId: number): string {
  return `ttsu-subplz-${jobId}`;
}

/** The `docker` arguments for one job (the job folder holds `book/` with the EPUB and audio). */
export function subplzArgs({
  jobId,
  jobDir,
  cacheDir,
  image,
}: {
  jobId: number;
  jobDir: string;
  cacheDir: string;
  image: string;
}): string[] {
  return [
    'run',
    '--rm',
    '--gpus',
    'all',
    '--name',
    containerName(jobId),
    '-v',
    `${jobDir}:/sync`,
    '-v',
    `${cacheDir}:/SyncCache`,
    image,
    'sync',
    '-d',
    '/sync/book',
  ];
}

/** The last percentage of a progress bar in SubPlz's output (tqdm: " 45%|████▌ |"), or null. */
export function parsePercent(text: string): number | null {
  let last: number | null = null;
  for (const m of text.matchAll(/(\d{1,3})%\|/g)) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 100) last = n / 100;
  }
  return last;
}

/** Keeps the last `max` lines of output (progress bars redraw with \r: the last state wins). */
export class Tail {
  private lines: string[] = [];
  private partial = '';
  constructor(private readonly max = 30) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.add(p);
  }

  private add(raw: string): void {
    const line =
      raw
        .split('\r')
        .filter((s) => s.trim() !== '')
        .pop()
        ?.trimEnd() ?? '';
    if (line === '') return;
    this.lines.push(line.slice(0, 500));
    if (this.lines.length > this.max) this.lines.shift();
  }

  text(): string {
    const last = this.partial
      .split('\r')
      .filter((s) => s.trim() !== '')
      .pop()
      ?.trimEnd();
    return [...this.lines, ...(last ? [last.slice(0, 500)] : [])].slice(-this.max).join('\n');
  }
}

export interface RunResult {
  /** Exit code of `docker run` (null when it was killed by a signal). */
  code: number | null;
  /** Why it was stopped by us, if it was. */
  stopped: 'cancel' | 'timeout' | null;
  tail: string;
}

export interface RunOptions {
  dockerPath: string;
  dockerPrefixArgs: string[];
  args: string[];
  jobId: number;
  maxRunMs: number;
  onPercent?: (p: number) => void;
  onOutput?: () => void;
}

/** A running SubPlz; `stop()` kills its container. */
export class SubplzRun {
  readonly done: Promise<RunResult>;
  private child: ChildProcess;
  private stopped: 'cancel' | 'timeout' | null = null;
  private readonly opts: RunOptions;

  constructor(opts: RunOptions) {
    this.opts = opts;
    const tail = new Tail();
    this.child = spawn(opts.dockerPath, [...opts.dockerPrefixArgs, ...opts.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      tail.push(s);
      opts.onOutput?.();
      const p = parsePercent(s);
      if (p !== null) opts.onPercent?.(p);
    };
    this.child.stdout!.on('data', onData);
    this.child.stderr!.on('data', onData);
    const timer = setTimeout(() => void this.stop('timeout'), opts.maxRunMs);
    this.done = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stopped: this.stopped, tail: tail.text() });
      };
      this.child.on('error', (err) => {
        tail.push(`\n${err.message}\n`);
        finish(-1);
      });
      this.child.on('close', (code) => finish(code));
    });
  }

  /** Kills the container (and the docker client); the run then ends. */
  async stop(why: 'cancel' | 'timeout'): Promise<void> {
    if (this.stopped) return;
    this.stopped = why;
    await runDocker(
      this.opts.dockerPath,
      [...this.opts.dockerPrefixArgs, 'kill', containerName(this.opts.jobId)],
      60_000,
    ).catch(() => undefined);
    // The client exits once the container is gone; make sure it does.
    setTimeout(() => this.child.kill(), 15_000).unref();
  }
}

/** Runs a short docker command; resolves with its output, rejects with its last error line. */
export function runDocker(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const last = `${stderr ?? ''}`.trim().split(/\r?\n/).pop();
          reject(new Error(last || err.message));
        } else resolve(String(stdout));
      },
    );
  });
}
