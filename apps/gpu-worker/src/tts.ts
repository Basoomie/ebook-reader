/**
 * WP17: the TTS jobs (generated audiobooks, previews, described voices). One job:
 *
 *   1. a fresh folder `<workDir>\job-<id>\` with job.json (the chapters still to read, from
 *      the server), voice.wav (the voice preset's clip) and out\;
 *   2. one container of the TTS program (ttsu-irodori, apps/gpu-worker/tts) reads them:
 *        docker run --rm --gpus all --name ttsu-tts-<id> -v <job>:/work
 *          -v <ttsModelsDir>:/models -e HF_HOME=/models/.shared -e HF_HUB_DISABLE_SYMLINKS=1
 *          <ttsImage> run --job /work/job.json
 *      The model is loaded once; models are downloaded once into the shared models folder
 *      (plain folders, no Hugging Face cache links, so every Windows account uses them);
 *   3. each finished chapter (out\part-NNNN.flac + .json) is uploaded at once and deleted,
 *      so a stopped or interrupted job continues with the next chapter later;
 *   4. Stop (from the reader) and the time limit kill the container (`docker kill`); the
 *      pause switch lets the current chapter finish, then the job goes back to the queue;
 *   5. the job folder is always removed.
 */
import { type ChildProcess, spawn } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import { type ClaimedJob, type ScriptChapter, ServerApi, ServerError, type Stage } from './api';
import type { WorkerSettings } from './config';
import type { Logger } from './log';
import { runDocker, Tail } from './subplz';

export function ttsContainerName(jobId: number): string {
  return `ttsu-tts-${jobId}`;
}

/** The `docker` arguments of one TTS run. */
export function ttsArgs({
  jobId,
  jobDir,
  modelsDir,
  image,
}: {
  jobId: number;
  jobDir: string;
  modelsDir: string;
  image: string;
}): string[] {
  return [
    'run',
    '--rm',
    '--gpus',
    'all',
    '--name',
    ttsContainerName(jobId),
    '-v',
    `${jobDir}:/work`,
    '-v',
    `${modelsDir}:/models`,
    '-e',
    'HF_HOME=/models/.shared',
    '-e',
    'HF_HUB_DISABLE_SYMLINKS=1',
    image,
    'run',
    '--job',
    '/work/job.json',
  ];
}

/** One "TTSU <kind> <rest>" line of the TTS program. */
export function parseTtsLine(line: string): { kind: string; rest: string; json: unknown } | null {
  const m = /^TTSU (\S+)\s?(.*)$/.exec(line.trim());
  if (!m) return null;
  let json: unknown = null;
  if (m[2].startsWith('{')) {
    try {
      json = JSON.parse(m[2]);
    } catch {
      json = null;
    }
  }
  return { kind: m[1], rest: m[2], json };
}

/** Whole-job progress (0..1) from chapters done and the current chapter's sentences. */
export function overallProgress(
  doneBefore: number,
  total: number,
  current: { done: number; total: number } | null,
): number {
  if (total <= 0) return 0;
  const frac = current && current.total > 0 ? current.done / current.total : 0;
  return Math.min(0.99, (doneBefore + frac) / total);
}

/** Kills the run's container when asked, or when it shows no progress for too long. */
class TtsRun {
  readonly done: Promise<{
    code: number | null;
    tail: string;
    stopped: 'cancel' | 'timeout' | 'pause' | null;
  }>;
  private child: ChildProcess;
  stopped: 'cancel' | 'timeout' | 'pause' | null = null;
  private lastActivity = Date.now();
  private buffered = '';

  constructor(
    private readonly s: WorkerSettings,
    private readonly jobId: number,
    args: string[],
    onLine: (line: string) => void,
  ) {
    const tail = new Tail(40);
    this.child = spawn(s.dockerPath, [...s.dockerPrefixArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail.push(text);
      this.buffered += text;
      const lines = this.buffered.split(/\r?\n/);
      this.buffered = lines.pop() ?? '';
      for (const l of lines) {
        if (l.startsWith('TTSU ')) {
          this.lastActivity = Date.now();
          onLine(l);
        }
      }
    };
    this.child.stdout!.on('data', onData);
    this.child.stderr!.on('data', (c: Buffer) => tail.push(c.toString('utf8')));
    const limitMs = s.ttsChapterMaxMinutes * 60_000;
    const timer = setInterval(
      () => {
        if (Date.now() - this.lastActivity > limitMs) void this.stop('timeout');
      },
      Math.min(30_000, Math.max(50, limitMs / 4)),
    );
    this.done = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (this.buffered.startsWith('TTSU ')) onLine(this.buffered);
        resolve({ code, tail: tail.text(), stopped: this.stopped });
      };
      this.child.on('error', (err) => {
        tail.push(`\n${err.message}\n`);
        finish(-1);
      });
      this.child.on('close', (code) => finish(code));
    });
  }

  async stop(why: 'cancel' | 'timeout' | 'pause'): Promise<void> {
    if (this.stopped) return;
    this.stopped = why;
    await runDocker(
      this.s.dockerPath,
      [...this.s.dockerPrefixArgs, 'kill', ttsContainerName(this.jobId)],
      60_000,
    ).catch(() => undefined);
    setTimeout(() => this.child.kill(), 15_000).unref();
  }
}

export class TtsStopped extends Error {}

/** Deletes the folders of models removed from the list in the reader. */
export async function removeDeletedModels(
  api: ServerApi,
  modelsDir: string,
  log: Logger,
): Promise<void> {
  let removed: { dir: string }[];
  try {
    removed = (await api.models()).removed;
  } catch {
    return;
  }
  for (const m of removed) {
    const parts = m.dir.split('/');
    if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p) || p === '..')) continue;
    const dir = path.join(modelsDir, ...parts);
    try {
      await fsp.access(dir);
    } catch {
      continue;
    }
    await fsp.rm(dir, { recursive: true, force: true });
    log.info(`Removed the model ${m.dir} (taken off the list in the reader)`);
    await fsp.rmdir(path.dirname(dir)).catch(() => undefined);
  }
}

/** Runs one TTS job. The caller removes the job folder afterwards. */
export async function runTtsJob({
  job,
  jobDir,
  s,
  api,
  log,
}: {
  job: ClaimedJob;
  jobDir: string;
  s: WorkerSettings;
  api: ServerApi;
  log: Logger;
}): Promise<{ tail: string | null }> {
  const tts = job.tts!;
  const out = path.join(jobDir, 'out');
  let stage: Stage = 'preparing';
  let progress: number | null = 0;
  let message: string | null = null;
  let cancelled = false;
  let pauseWanted = false;
  let run: TtsRun | null = null;
  const report = async () => {
    try {
      const r = await api.progress(job.id, { stage, progress, message });
      if (r.cancel && !cancelled) {
        cancelled = true;
        log.info(`Job ${job.id}: stopped from the reader`);
        await run?.stop('cancel');
      }
      if (r.pause && job.kind === 'generate_audiobook' && !pauseWanted) {
        pauseWanted = true;
        log.info(`Job ${job.id}: paused; stopping after the current chapter`);
      }
    } catch (err) {
      log.error(`Job ${job.id}: progress report failed: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(() => void report(), s.reportSeconds * 1000);
  try {
    await fsp.mkdir(out, { recursive: true });
    await report();
    if (cancelled) throw new TtsStopped();
    const script = await api.script(job.id);
    if (script.chapters.length === 0) throw new Error('Nothing left to read');
    let voice: string | null = null;
    if (tts.voice) {
      voice = path.join(jobDir, 'voice.wav');
      await api.download(job.id, 'voice', voice, () => undefined);
    }
    await fsp.mkdir(s.ttsModelsDir, { recursive: true });
    await fsp.writeFile(
      path.join(jobDir, 'job.json'),
      JSON.stringify({
        model: tts.model,
        modelsDir: '/models',
        precision: s.ttsPrecision,
        voice: voice ? '/work/voice.wav' : null,
        caption: tts.caption,
        seed: tts.seed,
        pauses: tts.pauses,
        whole: tts.whole,
        batch: s.ttsBatchSize,
        out: '/work/out',
        chapters: script.chapters satisfies ScriptChapter[],
      }),
      'utf8',
    );

    const total = tts.chaptersTotal;
    let doneCount = tts.chaptersDone;
    let uploads: Promise<void> = Promise.resolve();
    let uploadError: Error | null = null;
    const uploadChapter = async (index: number) => {
      const base = path.join(out, `part-${String(index).padStart(4, '0')}`);
      const meta = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as {
        durationMs: number;
        cues: number[][];
        spoken: string[];
      };
      await api.uploadChapter(job.id, index, `${base}.flac`);
      await api.finishChapter(job.id, index, meta);
      await fsp.rm(`${base}.flac`, { force: true });
      await fsp.rm(`${base}.json`, { force: true });
      doneCount += 1;
      progress = overallProgress(doneCount, total, null);
      log.info(`Job ${job.id}: chapter ${doneCount} of ${total} saved on the server`);
      if (pauseWanted && run && doneCount < total) await run.stop('pause');
    };

    stage = 'generating';
    message = 'Loading the model';
    await report();
    if (cancelled) throw new TtsStopped();
    log.info(`Job ${job.id}: TTS started (${tts.model.source})`);
    run = new TtsRun(
      s,
      job.id,
      ttsArgs({ jobId: job.id, jobDir, modelsDir: s.ttsModelsDir, image: s.ttsImage }),
      (line) => {
        const p = parseTtsLine(line);
        if (!p) return;
        if (p.kind === 'stage') {
          message =
            p.rest === 'downloading' || p.rest === 'loading'
              ? 'Loading the model'
              : p.rest === 'generating'
                ? 'Reading'
                : message;
        } else if (p.kind === 'model' && p.json) {
          const caps = p.json as { description?: boolean; clip?: boolean };
          void api
            .capabilities({
              source: tts.model.source,
              revision: tts.model.revision,
              description: caps.description === true,
              clip: caps.clip === true,
            })
            .catch(() => undefined);
        } else if (p.kind === 'progress' && p.json) {
          const j = p.json as {
            chapterNumber: number;
            chapters: number;
            done: number;
            total: number;
          };
          progress = overallProgress(doneCount, total, j);
          message = `Chapter ${Math.min(total, doneCount + 1)} of ${total}`;
        } else if (p.kind === 'chapter-done' && p.json) {
          const index = (p.json as { index: number }).index;
          uploads = uploads.then(async () => {
            if (uploadError || cancelled) return;
            try {
              await uploadChapter(index);
            } catch (err) {
              uploadError = err as Error;
              await run?.stop('cancel');
            }
          });
        } else if (p.kind === 'error') {
          message = p.rest.slice(0, 300);
        }
      },
    );
    const result = await run.done;
    await uploads;
    if (cancelled || result.stopped === 'cancel') {
      if (uploadError) throw uploadError;
      throw new TtsStopped();
    }
    if (uploadError) throw uploadError;
    if (result.stopped === 'pause') {
      await api.release(job.id);
      log.info(`Job ${job.id}: paused after ${doneCount} of ${total} chapters`);
      return { tail: null };
    }
    if (result.stopped === 'timeout') {
      throw Object.assign(
        new Error(
          `The TTS program showed no progress for ${s.ttsChapterMaxMinutes} minutes and was stopped`,
        ),
        { tail: result.tail },
      );
    }
    if (result.code !== 0) {
      const errorLine = result.tail
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('TTSU error '));
      const why =
        result.code === 137
          ? 'The TTS program was stopped by the system (out of memory?)'
          : `The TTS program failed (exit code ${result.code})`;
      throw Object.assign(
        new Error(errorLine ? `${why}: ${errorLine.slice('TTSU error '.length)}` : why),
        { tail: result.tail },
      );
    }
    if (doneCount < total && job.kind === 'generate_audiobook') {
      throw Object.assign(new Error('The TTS program ended before the last chapter'), {
        tail: result.tail,
      });
    }
    log.info(`Job ${job.id}: done`);
    return { tail: null };
  } finally {
    clearInterval(timer);
  }
}

export function isStopped(err: unknown, cancelledCode = 'cancelled'): boolean {
  return err instanceof TtsStopped || (err as ServerError)?.code === cancelledCode;
}
