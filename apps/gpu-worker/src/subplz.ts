/**
 * Runs SubPlz exactly like the user's known-good manual runs (decided 2026-11-12, copied
 * from the SubPlz README, flags not tuned):
 *
 *   docker run --rm --gpus all -v <content>:/sync -v <cache>:/SyncCache <image> sync -d /sync/<book folder>
 *
 * One difference, found in the first real run (2026-11-12): the pinned image (and every
 * image still on Docker Hub) no longer uses /SyncCache. It runs as uid 1000 with
 * BASE_PATH=HOME=/config and keeps its models there (TORCH_HOME, XDG_CACHE_HOME under
 * /config/cache), and /config is not writable without a mount, so SubPlz stopped at once.
 * The same shared cache folder is therefore mounted at /config.
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
    `${cacheDir}:/config`,
    image,
    'sync',
    '-d',
    '/sync/book',
  ];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * SubPlz's share of the work from its log lines, 0..1 for the whole run (not one bar).
 * SubPlz (the pinned image) prints several tqdm bars through its logger, one line per update
 * ("… | TQDM | P:1 | Transcribe:  69%|######9   | 1505.3/2176.73 [00:35<00:14, 46.52sec/s]"):
 *
 * - transcription, the long part (about 95 % of the time): one "Transcribe:" bar per chapter
 *   of the audio, counted in seconds of audio. Done = finished chapters' lengths + the current
 *   chapter's count, out of the audio's length (from the server's index);
 * - after "Transcription successful": matching the text, short; its bar counts chapter
 *   groups ("2/8"), the largest count bar seen in that part.
 *
 * The result only grows. Without the audio's length, the transcription part is unknown (null).
 */
export class SubplzProgress {
  static readonly TRANSCRIBE_SHARE = 0.95;
  private phase: 'transcribe' | 'match' = 'transcribe';
  private doneSeconds = 0;
  private bar: { n: number; total: number } | null = null;
  private matchFraction = 0;
  private matchTotal = 0;
  private best: number | null = null;

  constructor(private readonly audioSeconds: number | null) {}

  /** One line of SubPlz's output. */
  feed(raw: string): void {
    const line = raw.replace(ANSI, '');
    if (line.includes('Transcription successful')) {
      this.phase = 'match';
      this.raise(SubplzProgress.TRANSCRIBE_SHARE);
      return;
    }
    if (this.phase === 'transcribe') {
      const m = /Transcribe:\s*\d{1,3}%\|[^|]*\|\s*([\d.]+)\/([\d.]+)/.exec(line);
      if (!m) return;
      const n = Number(m[1]);
      const total = Number(m[2]);
      if (!Number.isFinite(n) || !Number.isFinite(total) || total <= 0) return;
      // A new chapter's bar: the previous chapter is done.
      if (this.bar && (Math.abs(total - this.bar.total) > 1e-6 || n < this.bar.n)) {
        this.doneSeconds += this.bar.total;
      }
      this.bar = { n, total };
      if (this.audioSeconds && this.audioSeconds > 0) {
        const f = Math.min(1, (this.doneSeconds + n) / this.audioSeconds);
        this.raise(f * SubplzProgress.TRANSCRIBE_SHARE);
      }
      return;
    }
    // Matching: a bar without a description that counts items ("| 2/8 [").
    const m = /\|\s*\d{1,3}%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[/.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    const total = Number(m[2]);
    // Bars of one item (the book, the audio file) say nothing about the groups.
    if (total <= 1 || total < this.matchTotal) return;
    if (total > this.matchTotal) {
      this.matchTotal = total;
      this.matchFraction = 0;
    }
    this.matchFraction = Math.max(this.matchFraction, Math.min(1, n / total));
    this.raise(
      SubplzProgress.TRANSCRIBE_SHARE + (1 - SubplzProgress.TRANSCRIBE_SHARE) * this.matchFraction,
    );
  }

  private raise(p: number): void {
    if (this.best === null || p > this.best) this.best = p;
  }

  /** 0..1 of SubPlz's whole run, or null while unknown. */
  value(): number | null {
    return this.best;
  }
}

/** Splits a stream's chunks into lines (tqdm may redraw with \r: each part is a line). */
export class LineSplitter {
  private partial = '';
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r\n|\n|\r/);
    this.partial = parts.pop() ?? '';
    for (const p of parts) if (p.trim() !== '') this.onLine(p);
  }
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
  /** Every line SubPlz prints (stdout and stderr). */
  onLine?: (line: string) => void;
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
    const lines = (line: string) => opts.onLine?.(line);
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      const splitter = new LineSplitter(lines);
      stream.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        tail.push(s);
        splitter.push(s);
      });
    }
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
