/**
 * WP15f: "Merge into one file". Joins the files of one audiobook folder, in the order
 * the user set, into one .m4b with a chapter marker per original file, saved next to the
 * originals. Decided with the user (2026-11-12): a merge button instead of multi-file
 * playback, so whispersync keeps playing one file.
 *
 * - One merge at a time; requests wait in a queue (audio_merge_jobs).
 * - ffprobe reads each file. Stream copy when every file is AAC with the same layout,
 *   otherwise (or when ffmpeg rejects the copy) re-encoding to AAC at AUDIO_MERGE_BITRATE.
 * - ffmpeg only reads the audiobooks folder; it writes into CACHE_DIR/audio-merge/<job>/
 *   (merge-workdir.ts). The finished, checked file is then saved into the audiobook's
 *   folder by audio-write.ts, the only writer there (new files only).
 * - A failure, a cancel, a stall (no progress for AUDIO_MERGE_STALL_MINUTES) or a restart
 *   leaves no partial file: the work folder is removed and audio-write.ts removes its own
 *   temp file.
 * - When done, that folder is re-indexed and the book is linked to the merged file, but
 *   only if the book's link is unchanged since the merge was asked for. The subtitle
 *   choice is cleared, so the subtitle step asks.
 */
import type Database from 'better-sqlite3';
import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AudioMergeConfig } from '../config';
import { resolveInsideAudio, statAudioFile } from './audio-fs';
import { type AudioFolder, getAudioFolderByRelPath } from './audio-index';
import { getLink, saveLink } from './audio-links';
import { AudioWriter, WriteAborted } from './audio-write';
import type { MergeWorkdir } from './merge-workdir';
import type { AudioScanService } from './scan-service';

export type MergeState = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled';
export type MergeMode = 'copy' | 'reencode';

export interface MergeJob {
  id: number;
  userId: string;
  bookId: string;
  libraryId: string;
  folderRelPath: string;
  folderName: string;
  files: string[];
  state: MergeState;
  mode: MergeMode | null;
  /** 0..1: joining is 0-0.9, saving into the audiobooks folder 0.9-1. */
  progress: number;
  outputName: string | null;
  error: string | null;
  /** The book was linked to the merged file. */
  linked: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface JobRow {
  id: number;
  user_id: string;
  book_id: string;
  library_id: string;
  folder_rel_path: string;
  file_names: string;
  state: MergeState;
  mode: MergeMode | null;
  progress: number;
  output_name: string | null;
  error: string | null;
  linked: number;
  link_confirmed_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const ACTIVE: MergeState[] = ['queued', 'running', 'saving'];

function toJob(r: JobRow): MergeJob {
  return {
    id: r.id,
    userId: r.user_id,
    bookId: r.book_id,
    libraryId: r.library_id,
    folderRelPath: r.folder_rel_path,
    folderName: path.posix.basename(r.folder_rel_path),
    files: JSON.parse(r.file_names) as string[],
    state: r.state,
    mode: r.mode,
    progress: r.progress,
    outputName: r.output_name,
    error: r.error,
    linked: r.linked === 1,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export class MergeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- ffprobe / ffmpeg

export interface ProbeStream {
  index: number;
  codecType: string;
  codecName: string | null;
  sampleRate: number | null;
  channels: number | null;
  profile: string | null;
  attachedPic: boolean;
}

export interface ProbeResult {
  duration: number;
  streams: ProbeStream[];
  tags: Record<string, string>;
  chapters: number;
}

export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: {
      index: number;
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      profile?: string;
      disposition?: { attached_pic?: number };
    }[];
    chapters?: unknown[];
  };
  const duration = Number(data.format?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : NaN,
    streams: (data.streams ?? []).map((s) => ({
      index: s.index,
      codecType: s.codec_type ?? '',
      codecName: s.codec_name ?? null,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
      channels: typeof s.channels === 'number' ? s.channels : null,
      profile: s.profile ?? null,
      attachedPic: s.disposition?.attached_pic === 1,
    })),
    tags: Object.fromEntries(
      Object.entries(data.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    ),
    chapters: (data.chapters ?? []).length,
  };
}

const audioStream = (p: ProbeResult) => p.streams.find((s) => s.codecType === 'audio') ?? null;
const coverStream = (p: ProbeResult) =>
  p.streams.find((s) => s.codecType === 'video' && s.attachedPic) ?? null;

/**
 * Stream copy is safe when every file is AAC with the same rate, channels and profile,
 * and the files have the same streams in the same order (the concat demuxer joins them
 * stream by stream).
 */
export function canStreamCopy(probes: ProbeResult[]): boolean {
  if (probes.length < 2) return false;
  const first = audioStream(probes[0]);
  if (!first || first.codecName !== 'aac') return false;
  const layout = (p: ProbeResult) => p.streams.map((s) => s.codecType).join(',');
  return probes.every((p) => {
    const a = audioStream(p);
    return (
      a !== null &&
      a.codecName === 'aac' &&
      a.sampleRate === first.sampleRate &&
      a.channels === first.channels &&
      a.profile === first.profile &&
      a.index === first.index &&
      layout(p) === layout(probes[0])
    );
  });
}

/** ffmetadata escaping: = ; # \ and newlines. */
function metaEscape(s: string): string {
  return s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? '\\\n' : `\\${c}`));
}

const KEPT_TAGS = [
  'artist',
  'album_artist',
  'album',
  'composer',
  'genre',
  'date',
  'copyright',
  'publisher',
  'comment',
  'description',
];

/** The chapter file: one chapter per original file, titled with its name. */
export function buildFfmetadata(
  files: { name: string; duration: number }[],
  firstTags: Record<string, string>,
  folderName: string,
): string {
  const lines = [';FFMETADATA1'];
  lines.push(`title=${metaEscape(firstTags.album || folderName)}`);
  for (const key of KEPT_TAGS) {
    if (firstTags[key]) lines.push(`${key}=${metaEscape(firstTags[key])}`);
  }
  let start = 0;
  for (const f of files) {
    const end = start + Math.max(1, Math.round(f.duration * 1000));
    const title = f.name.replace(/\.[^.]+$/, '');
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`);
    lines.push(`title=${metaEscape(title)}`);
    start = end;
  }
  return lines.join('\n') + '\n';
}

/** The concat demuxer's list; paths with forward slashes, quotes escaped. */
export function buildConcatList(files: string[]): string {
  return (
    files.map((f) => `file '${f.split(path.sep).join('/').replace(/'/g, "'\\''")}'`).join('\n') +
    '\n'
  );
}

export function ffmpegArgs({
  mode,
  inputs,
  listFile,
  metaFile,
  output,
  probes,
  bitrate,
}: {
  mode: MergeMode;
  inputs: string[];
  listFile: string;
  metaFile: string;
  output: string;
  probes: ProbeResult[];
  bitrate: string;
}): string[] {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  const cover = coverStream(probes[0]);
  let metaIndex: number;
  if (mode === 'copy') {
    // Every input before any -map (ffmpeg reads options before an -i as input options).
    args.push('-f', 'concat', '-safe', '0', '-i', listFile);
    args.push('-f', 'ffmetadata', '-i', metaFile);
    metaIndex = 1;
    // The cover comes from the first file alone (the concat input would join every cover).
    if (cover) args.push('-i', inputs[0]);
    args.push('-map', `0:${audioStream(probes[0])!.index}`);
    if (cover) args.push('-map', `2:${cover.index}`);
    args.push('-c:a', 'copy');
  } else {
    for (const f of inputs) args.push('-i', f);
    args.push('-f', 'ffmetadata', '-i', metaFile);
    metaIndex = inputs.length;
    const first = audioStream(probes[0]);
    const rate = first?.sampleRate ?? 44100;
    const mono = probes.every((p) => audioStream(p)?.channels === 1);
    const layout = mono ? 'mono' : 'stereo';
    const chains = inputs.map(
      (_, i) =>
        `[${i}:${audioStream(probes[i])!.index}]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=${layout}[a${i}]`,
    );
    const joined = inputs.map((_, i) => `[a${i}]`).join('');
    args.push(
      '-filter_complex',
      `${chains.join(';')};${joined}concat=n=${inputs.length}:v=0:a=1[out]`,
    );
    args.push('-map', '[out]');
    if (cover) args.push('-map', `0:${cover.index}`);
    args.push('-c:a', 'aac', '-b:a', bitrate);
  }
  if (cover) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

// ---------------------------------------------------------------- the service

export interface MergeServiceOptions {
  db: Database.Database;
  scan: AudioScanService;
  writer: AudioWriter;
  /** null when CACHE_DIR is not set (merging is off). */
  workdir: MergeWorkdir | null;
  config: AudioMergeConfig;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
  now?: () => number;
  /** Tests only: arguments put before ffmpeg's own (ffmpegPath = node, this = a script). */
  ffmpegPrefixArgs?: string[];
  /** Tests only: awaited just before the merged file is saved into the audiobooks folder. */
  beforeSave?: (job: MergeJob) => Promise<void>;
}

export interface MergeAvailability {
  available: boolean;
  reason: string | null;
}

export class MergeService {
  private readonly db: Database.Database;
  private readonly scan: AudioScanService;
  private readonly writer: AudioWriter;
  private readonly workdir: MergeWorkdir | null;
  private readonly config: AudioMergeConfig;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly now: () => number;
  private toolsProblem: string | null = 'not started';
  private running: Promise<void> | null = null;
  private current: { id: number; abort: AbortController; reason: 'cancel' | 'stop' | null } | null =
    null;
  private stopped = false;
  private readonly ffmpegPrefixArgs: string[];
  private readonly beforeSave: ((job: MergeJob) => Promise<void>) | null;

  constructor(opts: MergeServiceOptions) {
    this.ffmpegPrefixArgs = opts.ffmpegPrefixArgs ?? [];
    this.beforeSave = opts.beforeSave ?? null;
    this.db = opts.db;
    this.scan = opts.scan;
    this.writer = opts.writer;
    this.workdir = opts.workdir;
    this.config = opts.config;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.now = opts.now ?? Date.now;
  }

  availability(): MergeAvailability {
    const no = (reason: string): MergeAvailability => ({ available: false, reason });
    if (!this.scan.status.enabled) return no("The server's audiobooks folder isn't available");
    if (!this.workdir) return no('The server has no cache folder (CACHE_DIR) to merge in');
    if (!this.scan.status.writable) {
      return no("The server's audiobooks folder is read-only, so merged files can't be saved");
    }
    if (this.toolsProblem) return no(this.toolsProblem);
    return { available: true, reason: null };
  }

  /** At start: tidies interrupted merges and writes, then runs queued work (none). */
  async start(): Promise<void> {
    const interrupted = this.db
      .prepare(
        `UPDATE audio_merge_jobs SET state = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE state IN ('queued', 'running', 'saving')`,
      )
      .run(
        'Interrupted: the server restarted during the merge. Start it again.',
        this.now(),
        this.now(),
      ).changes;
    if (interrupted) this.log(`Audiobooks: ${interrupted} interrupted merge(s) marked failed`);
    try {
      await this.writer.recover();
    } catch (err) {
      this.logError('Audiobooks: could not tidy interrupted writes:', err);
    }
    if (this.workdir) {
      try {
        await this.workdir.clear();
      } catch (err) {
        this.logError('Audiobooks: could not empty the merge work folder:', err);
      }
    }
    this.toolsProblem = await this.checkTools();
    if (this.toolsProblem) this.log(`Audiobooks: merging is off: ${this.toolsProblem}`);
  }

  private async checkTools(): Promise<string | null> {
    for (const [name, bin, prefix] of [
      ['ffmpeg', this.config.ffmpegPath, this.ffmpegPrefixArgs],
      ['ffprobe', this.config.ffprobePath, []],
    ] as const) {
      try {
        await runFile(bin, [...prefix, '-version'], 30_000);
      } catch {
        return `${name} was not found on the server (${bin})`;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.current) {
      this.current.reason = 'stop';
      this.current.abort.abort();
    }
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ---------------------------------------------------------------- jobs

  get(id: number): MergeJob | null {
    const row = this.db.prepare('SELECT * FROM audio_merge_jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
    return row ? toJob(row) : null;
  }

  latestForBook(userId: string, bookId: string): MergeJob | null {
    const row = this.db
      .prepare(
        'SELECT * FROM audio_merge_jobs WHERE user_id = ? AND book_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(userId, bookId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** Queues a merge of `files` (in this order) of `folder` for the user's book. */
  enqueue(userId: string, bookId: string, folder: AudioFolder, files: unknown): MergeJob {
    const availability = this.availability();
    if (!availability.available) {
      throw new MergeRequestError(503, 'merge_off', availability.reason ?? 'Merging is off');
    }
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
      throw new MergeRequestError(400, 'invalid_body', 'files must be a list of file names');
    }
    const names = files as string[];
    if (names.length < 2) {
      throw new MergeRequestError(400, 'invalid_body', 'Choose at least two files to merge');
    }
    if (new Set(names).size !== names.length) {
      throw new MergeRequestError(400, 'invalid_body', 'A file is listed twice');
    }
    for (const n of names) {
      if (!folder.files.some((f) => f.name === n)) {
        throw new MergeRequestError(404, 'not_found', `No such file in this folder: ${n}`);
      }
    }
    if (folder.missingAt !== null) {
      throw new MergeRequestError(
        409,
        'missing',
        'This audiobook is no longer in the audiobooks folder',
      );
    }
    const now = this.now();
    const id = this.db.transaction(() => {
      const busy = this.db
        .prepare(
          `SELECT 1 FROM audio_merge_jobs WHERE folder_rel_path = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`,
        )
        .get(folder.relPath, ...ACTIVE);
      if (busy) {
        throw new MergeRequestError(409, 'busy', 'This audiobook is being merged already');
      }
      const link = getLink(this.db, userId, bookId);
      return Number(
        this.db
          .prepare(
            `INSERT INTO audio_merge_jobs (user_id, book_id, library_id, folder_rel_path, file_names,
               state, progress, link_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
          )
          .run(
            userId,
            bookId,
            folder.libraryId,
            folder.relPath,
            JSON.stringify(names),
            link?.confirmedAt ?? null,
            now,
            now,
          ).lastInsertRowid,
      );
    })();
    const job = this.get(id)!;
    this.kick();
    return job;
  }

  /** Stops a waiting or running merge of the user's. */
  cancel(userId: string, id: number): MergeJob | null {
    const job = this.get(id);
    if (!job || job.userId !== userId) return null;
    if (job.state === 'queued') {
      this.update(id, { state: 'cancelled', error: null, finished_at: this.now() });
    } else if ((job.state === 'running' || job.state === 'saving') && this.current?.id === id) {
      this.current.reason = 'cancel';
      this.current.abort.abort();
    }
    return this.get(id);
  }

  private update(id: number, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(
        `UPDATE audio_merge_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      )
      .run(...keys.map((k) => fields[k]), this.now(), id);
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = this.loop()
      .catch((err) => this.logError('Audiobooks: the merge queue failed:', err))
      .finally(() => {
        this.running = null;
      });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const next = this.db
        .prepare("SELECT * FROM audio_merge_jobs WHERE state = 'queued' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined;
      if (!next) return;
      await this.run(toJob(next), next.link_confirmed_at);
    }
  }

  private async freeBytes(dir: string): Promise<number | null> {
    try {
      const st = await fs.statfs(dir);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null;
    }
  }

  private async requireFree(dir: string, bytes: number, where: string): Promise<void> {
    const free = await this.freeBytes(dir);
    const need = bytes + this.config.minFreeMb * 1024 * 1024;
    if (free !== null && free < need) {
      const mb = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString('en-US')} MB`;
      throw new Error(`Not enough free space in ${where}: ${mb(free)} free, ${mb(need)} needed`);
    }
  }

  private async run(job: MergeJob, linkConfirmedAt: number | null): Promise<void> {
    const abort = new AbortController();
    this.current = { id: job.id, abort, reason: null };
    const workdir = this.workdir!;
    this.update(job.id, { state: 'running', progress: 0, started_at: this.now(), error: null });
    this.log(`Audiobooks: merging ${job.files.length} files of "${job.folderRelPath}"`);
    try {
      const folder = getAudioFolderByRelPath(this.db, job.folderRelPath);
      if (!folder || folder.missingAt !== null) {
        throw new Error('This audiobook is no longer in the audiobooks folder');
      }
      const inputs: string[] = [];
      let inputBytes = 0;
      for (const name of job.files) {
        const abs = resolveInsideAudio(this.scan.root, `${folder.relPath}/${name}`);
        const st = await statAudioFile(abs);
        if (!st) throw new Error(`${name} is no longer in the folder`);
        inputs.push(abs);
        inputBytes += st.size;
      }
      await workdir.prepare(job.id);
      await this.requireFree(workdir.root, inputBytes, "the server's cache folder");

      const probes: ProbeResult[] = [];
      for (const [i, file] of inputs.entries()) {
        const p = await this.probe(file, abort.signal);
        if (!audioStream(p) || !Number.isFinite(p.duration) || p.duration <= 0) {
          throw new Error(`${job.files[i]} could not be read as audio`);
        }
        probes.push(p);
      }
      const total = probes.reduce((n, p) => n + p.duration, 0);
      const listFile = await workdir.writeText(job.id, 'files.txt', buildConcatList(inputs));
      const metaFile = await workdir.writeText(
        job.id,
        'chapters.txt',
        buildFfmetadata(
          job.files.map((name, i) => ({ name, duration: probes[i].duration })),
          probes[0].tags,
          path.posix.basename(folder.relPath),
        ),
      );
      const output = workdir.outputPath(job.id);
      const attempt = async (mode: MergeMode) => {
        this.update(job.id, { mode, progress: 0 });
        await this.ffmpeg(
          job.id,
          ffmpegArgs({
            mode,
            inputs,
            listFile,
            metaFile,
            output,
            probes,
            bitrate: this.config.bitrate,
          }),
          total,
          abort.signal,
        );
        await this.verify(output, total, job.files.length, abort.signal);
      };
      if (canStreamCopy(probes)) {
        try {
          await attempt('copy');
        } catch (err) {
          if (abort.signal.aborted) throw err;
          this.log(`Audiobooks: stream copy did not work (${(err as Error).message}); re-encoding`);
          await attempt('reencode');
        }
      } else {
        await attempt('reencode');
      }

      const outSize = (await fs.stat(output)).size;
      this.update(job.id, { state: 'saving', progress: 0.9 });
      if (this.beforeSave) await this.beforeSave(this.get(job.id)!);
      if (abort.signal.aborted) throw new WriteAborted();
      const folderAbs = resolveInsideAudio(this.scan.root, folder.relPath);
      await this.requireFree(folderAbs, outSize, 'the audiobooks folder');
      let lastSaved = 0.9;
      const saved = await this.writer.createMergedFile({
        folderRelPath: folder.relPath,
        source: output,
        signal: abort.signal,
        onProgress: (written, size) => {
          const p = 0.9 + 0.1 * (size > 0 ? written / size : 1);
          if (p - lastSaved >= 0.005) {
            lastSaved = p;
            this.update(job.id, { progress: Math.min(p, 0.999) });
          }
        },
      });
      this.update(job.id, { output_name: saved.name });
      const fresh = await this.scan.rescanFolder(folder);
      const linked = this.autoLink(job, linkConfirmedAt, saved.name, fresh);
      this.update(job.id, {
        state: 'done',
        progress: 1,
        linked: linked ? 1 : 0,
        finished_at: this.now(),
      });
      this.log(
        `Audiobooks: merged "${job.folderRelPath}" into ${saved.name}${linked ? ' (linked)' : ''}`,
      );
    } catch (err) {
      const reason = this.current?.reason;
      if (abort.signal.aborted && reason === 'cancel') {
        this.update(job.id, { state: 'cancelled', error: null, finished_at: this.now() });
        this.log(`Audiobooks: merge of "${job.folderRelPath}" cancelled`);
      } else {
        const message =
          abort.signal.aborted && reason === 'stop'
            ? 'Interrupted: the server stopped during the merge. Start it again.'
            : err instanceof WriteAborted
              ? 'Stopped'
              : (err as Error).message;
        this.update(job.id, { state: 'failed', error: message, finished_at: this.now() });
        this.logError(`Audiobooks: merge of "${job.folderRelPath}" failed: ${message}`);
      }
    } finally {
      await workdir.remove(job.id).catch(() => undefined);
      this.current = null;
    }
  }

  private autoLink(
    job: MergeJob,
    linkConfirmedAt: number | null,
    name: string,
    fresh: AudioFolder | null,
  ): boolean {
    if (!fresh || !fresh.files.some((f) => f.name === name)) return false;
    const current = getLink(this.db, job.userId, job.bookId);
    if ((current?.confirmedAt ?? null) !== linkConfirmedAt) return false;
    saveLink(this.db, job.userId, {
      bookId: job.bookId,
      state: 'linked',
      folderRelPath: fresh.relPath,
      fileName: name,
      subtitleState: null,
      subtitleRelPath: null,
      source: 'library',
      confirmedAt: this.now(),
    });
    return true;
  }

  private stallMs(): number {
    return this.config.stallMinutes * 60_000;
  }

  private async probe(file: string, signal: AbortSignal): Promise<ProbeResult> {
    const out = await runFile(
      this.config.ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,profile:stream_disposition=attached_pic:chapter=id',
        '-of',
        'json',
        file,
      ],
      this.stallMs(),
      signal,
    );
    return parseProbe(out);
  }

  /** Checks ffmpeg's result: playable audio, the expected length, one chapter per file. */
  private async verify(
    output: string,
    expectedSeconds: number,
    chapters: number,
    signal: AbortSignal,
  ): Promise<void> {
    const p = await this.probe(output, signal);
    if (!audioStream(p)) throw new Error('The merged file has no audio');
    const tolerance = Math.max(2, expectedSeconds * 0.005);
    if (!(Math.abs(p.duration - expectedSeconds) <= tolerance)) {
      throw new Error(
        `The merged file is ${Math.round(p.duration)} s long, expected ${Math.round(expectedSeconds)} s`,
      );
    }
    if (p.chapters !== chapters) {
      throw new Error(`The merged file has ${p.chapters} chapters, expected ${chapters}`);
    }
  }

  /** Runs ffmpeg, reporting progress (0-0.9) and stopping it when it stalls or is aborted. */
  private ffmpeg(
    jobId: number,
    args: string[],
    totalSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new WriteAborted());
        return;
      }
      const child: ChildProcess = spawn(
        this.config.ffmpegPath,
        [...this.ffmpegPrefixArgs, ...args],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      try {
        if (child.pid) os.setPriority(child.pid, 10);
      } catch {
        // Lower priority is a nicety only.
      }
      let lastActivity = Date.now();
      let stalled = false;
      let stderr = '';
      let lastProgress = 0;
      let buffered = '';
      const onAbort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', onAbort);
      const timer = setInterval(
        () => {
          if (Date.now() - lastActivity > this.stallMs()) {
            stalled = true;
            child.kill('SIGKILL');
          }
        },
        Math.min(5_000, Math.max(50, this.stallMs() / 4)),
      );
      child.stdout!.on('data', (chunk: Buffer) => {
        lastActivity = Date.now();
        buffered += chunk.toString('utf8');
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line);
          if (!m || totalSeconds <= 0) continue;
          const p = Math.min(0.9, (Number(m[1]) / 1e6 / totalSeconds) * 0.9);
          if (p - lastProgress >= 0.005) {
            lastProgress = p;
            this.update(jobId, { progress: p });
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        lastActivity = Date.now();
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      const finish = (err: Error | null) => {
        clearInterval(timer);
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (signal.aborted) finish(new WriteAborted());
        else if (stalled) {
          finish(
            new Error(
              `ffmpeg made no progress for ${this.config.stallMinutes} minute(s) and was stopped`,
            ),
          );
        } else if (code !== 0) {
          const last = stderr.trim().split(/\r?\n/).pop() ?? '';
          finish(new Error(`ffmpeg failed${last ? `: ${last}` : ` (exit code ${code})`}`));
        } else finish(null);
      });
    });
  }
}

/** Runs a program and returns its standard output. */
function runFile(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        if (err) {
          const last = String(stderr ?? '')
            .trim()
            .split(/\r?\n/)
            .pop();
          reject(new Error(last || err.message));
        } else resolve(String(stdout));
      },
    );
  });
}
