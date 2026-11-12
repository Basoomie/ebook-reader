/**
 * The worker loop. While idle it checks in with the server (which says whether the
 * worker is paused and how often to ask) and asks for a job. A job:
 *
 *   1. a fresh folder `<workDir>\job-<id>\book\` (plain ASCII names: the real book and
 *      audio names have spaces and Japanese characters);
 *   2. downloads `book.epub` and `audio.<ext>` from the server;
 *   3. runs SubPlz (subplz.ts) on that folder;
 *   4. uploads `book\audio.srt`; the server saves it and links it;
 *   5. always deletes `job-<id>` again.
 *
 * While a job runs it reports every reportSeconds (that keeps the job; the answer says
 * when the user stopped it). It never writes anywhere but its own work folder and log.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { type ClaimedJob, ServerApi, ServerError, type Stage } from './api';
import type { WorkerSettings } from './config';
import type { Logger } from './log';
import { runDocker, SubplzRun, subplzArgs } from './subplz';

export const WORKER_VERSION = '1.0.0';

const AUDIO_EXTENSIONS = new Set(['.m4b', '.m4a', '.mp3']);

/** The audio file's name in the job folder: `audio` plus its own extension. */
export function audioNameFor(original: string): string {
  const ext = path.extname(original).toLowerCase();
  return `audio${AUDIO_EXTENSIONS.has(ext) ? ext : '.m4b'}`;
}

export function jobDirFor(workDir: string, jobId: number): string {
  return path.join(workDir, `job-${jobId}`);
}

/** Messages shown on the book's page: short, no folder names of this PC. */
export function plainError(message: string, workDir: string): string {
  let out = message;
  for (const form of new Set([workDir, workDir.split('\\').join('/')])) {
    out = out.split(form).join('<work folder>');
  }
  return out.slice(0, 1000);
}

export class Stopped extends Error {}

export interface WorkerDeps {
  settings: WorkerSettings;
  api: ServerApi;
  log: Logger;
  /** Free bytes on the work folder's drive; null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

async function statfsFree(dir: string): Promise<number | null> {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export class Worker {
  private readonly s: WorkerSettings;
  private readonly api: ServerApi;
  private readonly log: Logger;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private currentJobId: number | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private lastProblem: string | null | undefined = undefined;

  constructor(deps: WorkerDeps) {
    this.s = deps.settings;
    this.api = deps.api;
    this.log = deps.log;
    this.freeBytes = deps.freeBytes ?? statfsFree;
  }

  /** Why the worker can't run SubPlz right now (Docker down, image missing), or null. */
  async problem(): Promise<string | null> {
    const docker = (args: string[]) =>
      runDocker(this.s.dockerPath, [...this.s.dockerPrefixArgs, ...args], 60_000);
    try {
      await docker(['info', '--format', '{{.ServerVersion}}']);
    } catch {
      return 'Docker Desktop is not running on the PC';
    }
    try {
      await docker(['image', 'inspect', '--format', '{{.Id}}', this.s.image]);
    } catch {
      return `The SubPlz image is not on the PC (docker pull ${this.s.image})`;
    }
    return null;
  }

  /** Empties the work folder of jobs left by an earlier run (the PC was switched off). */
  async clearLeftovers(): Promise<void> {
    await fsp.mkdir(this.s.workDir, { recursive: true });
    for (const name of await fsp.readdir(this.s.workDir)) {
      if (/^job-\d+$/.test(name)) {
        await fsp.rm(path.join(this.s.workDir, name), { recursive: true, force: true });
        this.log.info(`Removed the leftover folder ${name}`);
      }
    }
  }

  /** One round: check in, and run a job if there is one. Returns seconds to wait. */
  async tick(): Promise<number> {
    let problem: string | null;
    try {
      problem = await this.problem();
    } catch (err) {
      problem = (err as Error).message;
    }
    if (problem !== this.lastProblem) {
      if (problem) this.log.error(problem);
      else if (this.lastProblem) this.log.info('Docker and the SubPlz image are ready');
      this.lastProblem = problem;
    }
    const hb = await this.api.heartbeat({
      version: WORKER_VERSION,
      image: this.s.image,
      problem,
      currentJobId: this.currentJobId,
    });
    if (hb.paused || problem) return hb.pollSeconds;
    const job = await this.api.claim();
    if (!job) return hb.pollSeconds;
    await this.runJob(job);
    return 0;
  }

  /** Runs until stop(). Network errors are logged and retried. */
  async run(): Promise<void> {
    await this.clearLeftovers();
    this.log.info(`GPU worker ${WORKER_VERSION} started; server ${this.s.serverUrl}`);
    let failures = 0;
    while (!this.stopping) {
      let wait: number;
      try {
        wait = await this.tick();
        failures = 0;
      } catch (err) {
        failures += 1;
        // Log the first failure and then every 20th (the NAS may be off for hours).
        if (failures === 1 || failures % 20 === 0) {
          this.log.error(`Can't reach the server: ${(err as Error).message}`);
        }
        wait = Math.min(300, 15 * failures);
      }
      if (wait > 0 && !this.stopping) await this.sleep(wait * 1000);
    }
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  /** Does one job from download to upload; always removes its folder. */
  async runJob(job: ClaimedJob): Promise<void> {
    this.currentJobId = job.id;
    const jobDir = jobDirFor(this.s.workDir, job.id);
    const bookDir = path.join(jobDir, 'book');
    const title = job.bookTitle ?? job.audioFileName;
    this.log.info(`Job ${job.id}: "${title}"`);

    let stage: Stage = 'downloading';
    let progress: number | null = 0;
    let cancelled = false;
    const abort = new AbortController();
    let run: SubplzRun | null = null;
    const report = async () => {
      try {
        const r = await this.api.progress(job.id, { stage, progress, message: null });
        if (r.cancel && !cancelled) {
          cancelled = true;
          this.log.info(`Job ${job.id}: stopped from the reader`);
          abort.abort();
          await run?.stop('cancel');
        }
      } catch (err) {
        // The lease allows missed reports; the next one may get through.
        this.log.error(`Job ${job.id}: progress report failed: ${(err as Error).message}`);
      }
    };
    const timer = setInterval(() => void report(), this.s.reportSeconds * 1000);
    let tail: string | null = null;
    try {
      await fsp.rm(jobDir, { recursive: true, force: true });
      await fsp.mkdir(bookDir, { recursive: true });
      const need =
        job.audioSize + (job.epubSize ?? 0) + Math.round(this.s.minFreeGB * 1024 * 1024 * 1024);
      const free = await this.freeBytes(this.s.workDir);
      if (free !== null && free < need) {
        const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
        throw new Error(`Not enough free space on the PC: ${gb(free)} free, ${gb(need)} needed`);
      }
      await report();
      if (cancelled) throw new Stopped();

      const total = job.audioSize + (job.epubSize ?? 0);
      let epubBytes = 0;
      await this.api.download(
        job.id,
        'epub',
        path.join(bookDir, 'book.epub'),
        (n) => {
          epubBytes = n;
          progress = total > 0 ? Math.min(1, n / total) : null;
        },
        abort.signal,
      );
      await this.api.download(
        job.id,
        'audio',
        path.join(bookDir, audioNameFor(job.audioFileName)),
        (n) => {
          progress = total > 0 ? Math.min(1, (epubBytes + n) / total) : null;
        },
        abort.signal,
      );
      if (cancelled) throw new Stopped();

      stage = 'syncing';
      progress = null;
      await report();
      if (cancelled) throw new Stopped();
      this.log.info(`Job ${job.id}: SubPlz started`);
      run = new SubplzRun({
        dockerPath: this.s.dockerPath,
        dockerPrefixArgs: this.s.dockerPrefixArgs,
        args: subplzArgs({
          jobId: job.id,
          jobDir,
          cacheDir: this.s.cacheDir,
          image: this.s.image,
        }),
        jobId: job.id,
        maxRunMs: this.s.maxRunHours * 3600 * 1000,
        onPercent: (p) => {
          progress = p;
        },
      });
      const result = await run.done;
      tail = result.tail;
      if (cancelled || result.stopped === 'cancel') throw new Stopped();
      if (result.stopped === 'timeout') {
        throw new Error(`SubPlz ran longer than ${this.s.maxRunHours} hours and was stopped`);
      }
      if (result.code !== 0) {
        const last = result.tail.split('\n').pop() ?? '';
        const why =
          result.code === 137
            ? 'SubPlz was stopped by the system (out of memory?)'
            : `SubPlz failed (exit code ${result.code})`;
        throw new Error(last ? `${why}: ${last}` : why);
      }
      const srt = await this.findResult(bookDir);
      if (!srt) throw new Error('SubPlz finished without making a subtitle file');

      stage = 'uploading';
      progress = null;
      await report();
      if (cancelled) throw new Stopped();
      const data = await fsp.readFile(srt);
      const saved = await this.api.uploadResult(job.id, data);
      if (saved.state === 'done') {
        this.log.info(
          `Job ${job.id}: saved as ${saved.outputName}${saved.linked ? ' and linked' : ''}`,
        );
      } else {
        this.log.error(`Job ${job.id}: the server could not save it: ${saved.error}`);
      }
    } catch (err) {
      const stoppedByUser =
        cancelled || err instanceof Stopped || (err as ServerError).code === 'cancelled';
      const message = stoppedByUser
        ? 'Stopped'
        : plainError((err as Error).message || String(err), this.s.workDir);
      if (!stoppedByUser) this.log.error(`Job ${job.id} failed: ${message}`);
      try {
        await this.api.fail(job.id, {
          error: message,
          logTail: tail ? plainError(tail, this.s.workDir) : null,
        });
      } catch (e) {
        this.log.error(`Job ${job.id}: could not report the failure: ${(e as Error).message}`);
      }
    } finally {
      clearInterval(timer);
      await fsp.rm(jobDir, { recursive: true, force: true }).catch((e) => {
        this.log.error(`Job ${job.id}: could not remove ${jobDir}: ${(e as Error).message}`);
      });
      this.currentJobId = null;
    }
  }

  /** SubPlz writes `<audio name>.srt` next to the audio. */
  private async findResult(bookDir: string): Promise<string | null> {
    const expected = path.join(bookDir, 'audio.srt');
    if (fs.existsSync(expected)) return expected;
    const other = (await fsp.readdir(bookDir)).find((n) => n.toLowerCase().endsWith('.srt'));
    return other ? path.join(bookDir, other) : null;
  }
}
