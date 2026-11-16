/**
 * Season 2 Phase 12 session 3: the voice kept loaded (decided with the user, 2026-11-16).
 * One long-lived container of the TTS program in `serve` mode (tts/ttsu_tts.py cmd_serve):
 *
 *   docker run --rm -i --gpus all --name ttsu-tts-live -v <workDir>\live:/work
 *     -v <ttsModelsDir>:/models -e HF_HOME=/models/.shared -e HF_HUB_DISABLE_SYMLINKS=1
 *     <ttsImage> serve
 *
 * It takes one JSON request per line on stdin (load a model, read sentences, quit) and
 * answers with "TTSU …" lines. The model is loaded once (90–124 s on the RTX 4070), then a
 * batch of sentences takes seconds. Live read-aloud and Enrich's sentence clips use it; the
 * worker lets it go when the server says the keep time is over, before any other job (an
 * audiobook chapter needs nearly all of the GPU's memory), and on Pause.
 *
 * Files: `<workDir>\live\voices\<sha256>.wav` (voice clips, kept while it runs) and
 * `<workDir>\live\out\<name>.flac|.json` (one read, deleted by the caller after upload).
 * The folder is emptied whenever a new process starts.
 */
import { type ChildProcess, spawn } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import type { WorkerSettings } from './config';
import type { Logger } from './log';
import { runDocker, Tail } from './subplz';
import { parseTtsLine } from './tts';

export const ENGINE_CONTAINER = 'ttsu-tts-live';

export interface EngineModel {
  source: string;
  revision: string;
}

/** What the worker reports to the server about the process (null: none). */
export interface EngineReport extends EngineModel {
  state: 'loading' | 'ready';
}

export interface ReadRequest {
  sentences: {
    text: string;
    reading: string;
    paragraphEnd: boolean;
    segments?: { reading: string; voice: string }[];
  }[];
  /** The voice clip's sha256 (its file must be in voices\, see voiceFile), or null. */
  voiceSha: string | null;
  /**
   * Session 4: every voice a sentence's segments may name, by key: its clip's sha256 (file
   * in voices\) and seed.
   */
  voices?: Record<string, { sha256: string; seed: number }>;
  caption: string | null;
  seed: number;
  pauses: { sentenceMs: number; paragraphMs: number; chapterMs?: number; dialogueMs?: number };
  whole: boolean;
  /** The pause after the last sentence (ms). */
  lastGapMs: number;
  /** The output's file name (no extension), e.g. "b-12". */
  name: string;
}

export interface ReadResult {
  flac: string;
  meta: { durationMs: number; cues: number[][]; spoken: string[] };
}

/** The `docker` arguments of the voice process. */
export function engineArgs({
  liveDir,
  modelsDir,
  image,
}: {
  liveDir: string;
  modelsDir: string;
  image: string;
}): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--gpus',
    'all',
    '--name',
    ENGINE_CONTAINER,
    '-v',
    `${liveDir}:/work`,
    '-v',
    `${modelsDir}:/models`,
    '-e',
    'HF_HOME=/models/.shared',
    '-e',
    'HF_HUB_DISABLE_SYMLINKS=1',
    image,
    'serve',
  ];
}

interface Pending {
  kind: 'load' | 'read';
  id: string | null;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

export class EngineError extends Error {}

export class VoiceEngine {
  readonly liveDir: string;
  private child: ChildProcess | null = null;
  private model: EngineModel | null = null;
  private loadedState: 'loading' | 'ready' | null = null;
  private buffered = '';
  private tail = new Tail(40);
  private pending: Pending | null = null;
  /** Requests run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastActivity = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(
    private readonly s: WorkerSettings,
    private readonly log: Logger,
  ) {
    this.liveDir = path.join(s.workDir, 'live');
  }

  /** What to tell the server (null: no process, or it isn't loading or loaded). */
  report(): EngineReport | null {
    if (!this.child || !this.model || !this.loadedState) return null;
    return { state: this.loadedState, ...this.model };
  }

  /** Loaded and ready with `model`. */
  readyWith(model: EngineModel): boolean {
    return (
      this.loadedState === 'ready' &&
      !!this.model &&
      this.model.source === model.source &&
      this.model.revision === model.revision
    );
  }

  get running(): boolean {
    return this.child !== null;
  }

  private docker(args: string[], timeoutMs = 60_000): Promise<string> {
    return runDocker(this.s.dockerPath, [...this.s.dockerPrefixArgs, ...args], timeoutMs);
  }

  /** The host path of a voice clip (downloaded by the caller when it is missing). */
  voiceFile(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Bad voice id');
    return path.join(this.liveDir, 'voices', `${sha256}.wav`);
  }

  private checkedSha(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Bad voice id');
    return sha256;
  }

  async hasVoice(sha256: string): Promise<boolean> {
    try {
      await fsp.access(this.voiceFile(sha256));
      return true;
    } catch {
      return false;
    }
  }

  private async start(): Promise<void> {
    // A container left by a worker that stopped without letting it go.
    await this.docker(['rm', '-f', ENGINE_CONTAINER]).catch(() => undefined);
    await fsp.rm(this.liveDir, { recursive: true, force: true });
    await fsp.mkdir(path.join(this.liveDir, 'voices'), { recursive: true });
    await fsp.mkdir(path.join(this.liveDir, 'out'), { recursive: true });
    await fsp.mkdir(this.s.ttsModelsDir, { recursive: true });
    this.tail = new Tail(40);
    this.buffered = '';
    const child = spawn(
      this.s.dockerPath,
      [
        ...this.s.dockerPrefixArgs,
        ...engineArgs({
          liveDir: this.liveDir,
          modelsDir: this.s.ttsModelsDir,
          image: this.s.ttsImage,
        }),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    this.lastActivity = Date.now();
    child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => this.tail.push(chunk.toString('utf8')));
    child.stdin!.on('error', () => undefined);
    child.on('error', (err) => this.onExit(`could not start: ${err.message}`));
    child.on('close', (code) => this.onExit(`exit code ${code}`));
    // A request that shows no progress for ttsChapterMaxMinutes is stopped.
    const limitMs = this.s.ttsChapterMaxMinutes * 60_000;
    this.watchdog = setInterval(
      () => {
        if (this.pending && Date.now() - this.lastActivity > limitMs) {
          this.log.error(
            `The voice process showed no progress for ${this.s.ttsChapterMaxMinutes} minutes; stopping it`,
          );
          void this.kill();
        }
      },
      Math.min(30_000, Math.max(50, limitMs / 4)),
    );
    this.watchdog.unref();
    this.log.info('Voice process started');
  }

  private onData(text: string): void {
    this.tail.push(text);
    this.buffered += text;
    const lines = this.buffered.split(/\r?\n/);
    this.buffered = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('TTSU ')) continue;
      this.lastActivity = Date.now();
      const p = parseTtsLine(l);
      if (!p) continue;
      const json = p.json as Record<string, unknown> | null;
      const pending = this.pending;
      if (p.kind === 'progress' && pending?.onProgress && json) {
        pending.onProgress(Number(json.done) || 0, Number(json.total) || 0);
      } else if (p.kind === 'loaded' && pending?.kind === 'load') {
        this.pending = null;
        pending.resolve(json);
      } else if (p.kind === 'load-error' && pending?.kind === 'load') {
        this.pending = null;
        pending.reject(new EngineError(String(json?.error ?? 'the model could not be loaded')));
      } else if (
        (p.kind === 'read-done' || p.kind === 'read-error') &&
        pending?.kind === 'read' &&
        json?.id === pending.id
      ) {
        this.pending = null;
        if (p.kind === 'read-done') pending.resolve(json);
        else
          pending.reject(new EngineError(String(json?.error ?? 'the sentences could not be read')));
      }
    }
  }

  private onExit(why: string): void {
    if (!this.child) return;
    this.child = null;
    this.model = null;
    this.loadedState = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const pending = this.pending;
    this.pending = null;
    const last = this.tail
      .text()
      .split('\n')
      .reverse()
      .find((l) => l.trim() !== '' && !l.startsWith('TTSU '));
    this.log.info(`Voice process ended (${why})`);
    pending?.reject(
      new EngineError(
        `The voice process stopped (${why})${last ? `: ${last.trim().slice(0, 300)}` : ''}`,
      ),
    );
  }

  private send(req: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new EngineError('The voice process is not running');
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  private request<T>(
    kind: 'load' | 'read',
    body: Record<string, unknown>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<T> {
    const run = this.queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = kind === 'read' ? `r${this.nextId++}` : null;
          this.pending = {
            kind,
            id,
            resolve: resolve as (v: unknown) => void,
            reject,
            onProgress,
          };
          this.lastActivity = Date.now();
          try {
            this.send({ ...body, op: kind, ...(id ? { id } : {}) });
          } catch (err) {
            this.pending = null;
            reject(err as Error);
          }
        }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Starts the process if needed and loads `model` (another model replaces the one loaded). */
  async ensure(model: EngineModel): Promise<void> {
    if (this.readyWith(model)) return;
    if (!this.child) await this.start();
    this.model = { ...model };
    this.loadedState = 'loading';
    this.log.info(`Loading the voice model ${model.source}`);
    try {
      const caps = await this.request<Record<string, unknown>>('load', {
        model,
        precision: this.s.ttsPrecision,
        modelsDir: '/models',
      });
      if (this.model?.source === model.source && this.model.revision === model.revision) {
        this.loadedState = 'ready';
      }
      this.log.info(
        `Voice model loaded${caps && typeof caps.loadSeconds === 'number' ? ` in ${Math.round(caps.loadSeconds)} s` : ''}`,
      );
    } catch (err) {
      this.loadedState = null;
      this.model = null;
      throw err;
    }
  }

  /** Reads sentences with the loaded model; the FLAC and its timings are in out\. */
  async read(
    req: ReadRequest,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ReadResult> {
    if (this.loadedState !== 'ready') throw new EngineError('No voice model is loaded');
    if (!/^[\w.-]+$/.test(req.name)) throw new Error('Bad output name');
    const done = await this.request<{ durationMs: number }>(
      'read',
      {
        sentences: req.sentences,
        voice: req.voiceSha ? `/work/voices/${req.voiceSha}.wav` : null,
        voices: req.voices
          ? Object.fromEntries(
              Object.entries(req.voices).map(([key, v]) => [
                key,
                { voice: `/work/voices/${this.checkedSha(v.sha256)}.wav`, seed: v.seed },
              ]),
            )
          : null,
        caption: req.caption,
        seed: req.seed,
        pauses: req.pauses,
        batch: this.s.ttsBatchSize,
        whole: req.whole,
        lastGapMs: req.lastGapMs,
        out: '/work/out',
        name: req.name,
      },
      onProgress,
    );
    const base = path.join(this.liveDir, 'out', req.name);
    const meta = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as ReadResult['meta'];
    if (meta.durationMs !== done.durationMs) meta.durationMs = done.durationMs;
    return { flac: `${base}.flac`, meta };
  }

  /** Removes a read's files (after the upload). */
  async forget(name: string): Promise<void> {
    const base = path.join(this.liveDir, 'out', name);
    await fsp.rm(`${base}.flac`, { force: true });
    await fsp.rm(`${base}.json`, { force: true });
  }

  /** Lets the voice go: "quit", then the container is killed if it is still there. */
  async quit(why: string): Promise<void> {
    if (!this.child) return;
    this.log.info(`Letting the voice go (${why})`);
    const child = this.child;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      this.send({ op: 'quit' });
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000));
    if ((await Promise.race([closed, timer])) === 'timeout') await this.kill();
  }

  /** Stops the container at once (a stuck request, or the worker stops). */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.docker(['kill', ENGINE_CONTAINER]).catch(() => undefined);
    setTimeout(() => {
      if (this.child === child) child.kill();
    }, 15_000).unref();
  }
}
