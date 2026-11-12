/**
 * WP16: the GPU worker's job queue. A job is queued only by the user, from a book's page
 * ("Make subtitles on the PC"); the worker on the user's PC (apps/gpu-worker) asks for work,
 * downloads the book's EPUB and its linked audio file, runs SubPlz exactly like the user's
 * manual runs, and uploads the .srt. The server writes it, through audio-write.ts (new files
 * only), to `<subtitle folder>/_generated/<title>.srt`, indexes it, and links it to the book
 * if the book's link is unchanged since the job was queued.
 *
 * - Before queuing, the subtitle archive is checked for an existing match (decided): a
 *   candidate scoring at least SUBTITLE_ARCHIVE_MATCH_MIN is offered first (409
 *   archive_match); the user can still ask for new subtitles (force).
 * - One job runs at a time. The worker holds it with a lease that its reports extend; if
 *   the PC goes away mid-job the lease runs out and the job goes back to the queue, up to
 *   WORKER_MAX_ATTEMPTS. Queued jobs simply wait while the PC is off.
 * - The pause switch (Settings > Audiobooks) is stored here: a paused worker gets no new job.
 * - Stopping a running job sets a flag the worker sees on its next report; it stops SubPlz
 *   and reports back. Nothing is written for a stopped job.
 *
 * Kinds: 'sync_subtitles' here; WP17's 'generate_audiobook', 'preview_audiobook' and
 * 'voice_sample' (tts-jobs.ts) share the queue, the lease, the pause switch and Stop: they
 * register a handler (registerKind) that prepares what the worker gets when it claims one.
 */
import type Database from 'better-sqlite3';
import { getLibrary } from '../calibre/libraries';
import { getBookFileFor } from '../catalog/queries';
import type { WorkerConfig } from '../config';
import { getAudioFolderByRelPath, listSubtitleFiles, type AudioFolder } from './audio-index';
import { getLink, resolveLink, saveLink } from './audio-links';
import { type AudioWriter, subtitleNameCandidates } from './audio-write';
import { rankEntries } from './match';
import { shortenPaths } from './merge-service';
import type { AudioScanService } from './scan-service';
import { subtitleSummary, type SubtitleSummary } from './summary';

export type WorkerJobKind =
  | 'sync_subtitles'
  | 'generate_audiobook'
  | 'preview_audiobook'
  | 'voice_sample';
export type WorkerJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type WorkerJobStage =
  | 'downloading'
  | 'syncing'
  | 'uploading'
  | 'saving'
  | 'preparing'
  | 'generating'
  | 'assembling';

export const WORKER_STAGES: WorkerJobStage[] = [
  'downloading',
  'syncing',
  'uploading',
  'saving',
  'preparing',
  'generating',
  'assembling',
];

/**
 * WP17: a job kind other than 'sync_subtitles' (tts-jobs.ts). `claim` gives what the
 * worker needs (sent as `tts`), or why the job can't run (it then fails).
 * `countsAsAttempt`: whether a lease that ran out counts against WORKER_MAX_ATTEMPTS.
 */
export interface WorkerKindHandler {
  claim(job: WorkerJob): { tts: unknown } | { error: string };
  countsAsAttempt?(job: WorkerJob): boolean;
}

export interface WorkerJob {
  id: number;
  userId: string;
  /** null only for a voice sample (WP17). */
  bookId: string | null;
  bookTitle: string | null;
  kind: WorkerJobKind;
  libraryId: string | null;
  /** The linked audio of a 'sync_subtitles' job (null for the WP17 kinds). */
  audioFolderRelPath: string | null;
  audioFileName: string | null;
  state: WorkerJobState;
  stage: WorkerJobStage | null;
  /** 0..1 within the stage, or null when unknown (SubPlz doesn't always say). */
  progress: number | null;
  /** The worker's own line, e.g. "SubPlz: transcribing 3/12". */
  message: string | null;
  cancelRequested: boolean;
  attempts: number;
  /** Root-relative path of the saved subtitle file. */
  outputRelPath: string | null;
  outputName: string | null;
  linked: boolean;
  error: string | null;
  /** The last lines of SubPlz's output when it failed. */
  logTail: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  /** WP17: the job's settings (voice map v1 for audiobooks), parsed. */
  params: Record<string, unknown> | null;
  /** WP17: the generated audiobook's version (1, 2, …). */
  version: number | null;
  chaptersTotal: number | null;
  chaptersDone: number;
}

interface JobRow {
  id: number;
  user_id: string;
  book_id: string | null;
  book_title: string | null;
  kind: WorkerJobKind;
  library_id: string | null;
  audio_folder_rel_path: string | null;
  audio_file_name: string | null;
  link_confirmed_at: number | null;
  state: WorkerJobState;
  stage: WorkerJobStage | null;
  progress: number | null;
  message: string | null;
  cancel_requested: number;
  attempts: number;
  lease_expires_at: number | null;
  output_rel_path: string | null;
  linked: number;
  error: string | null;
  log_tail: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  params: string | null;
  version: number | null;
  chapters_total: number | null;
  chapters_done: number;
  claim_chapters: number | null;
}

const JOB_SELECT = `SELECT j.*, b.title AS book_title FROM worker_jobs j
  LEFT JOIN books b ON b.id = j.book_id`;

function toJob(r: JobRow): WorkerJob {
  return {
    id: r.id,
    userId: r.user_id,
    bookId: r.book_id,
    bookTitle: r.book_title,
    kind: r.kind,
    libraryId: r.library_id,
    audioFolderRelPath: r.audio_folder_rel_path,
    audioFileName: r.audio_file_name,
    state: r.state,
    stage: r.stage,
    progress: r.progress,
    message: r.message,
    cancelRequested: r.cancel_requested === 1,
    attempts: r.attempts,
    outputRelPath: r.output_rel_path,
    outputName: r.output_rel_path ? r.output_rel_path.split('/').pop()! : null,
    linked: r.linked === 1,
    error: r.error,
    logTail: r.log_tail,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
    params: parseParams(r.params),
    version: r.version,
    chaptersTotal: r.chapters_total,
    chaptersDone: r.chapters_done,
  };
}

function parseParams(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class JobRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface WorkerStatus {
  /** Seen within WORKER_OFFLINE_SECONDS. */
  online: boolean;
  lastSeenAt: number | null;
  paused: boolean;
  version: string | null;
  image: string | null;
  /** WP17: the TTS program image the worker reported. */
  ttsImage: string | null;
  /** What keeps the worker from working, as it reported it (e.g. Docker not running). */
  problem: string | null;
  /** The user's queued and running jobs, oldest first. */
  jobs: WorkerJob[];
}

export interface HeartbeatInput {
  version?: unknown;
  image?: unknown;
  ttsImage?: unknown;
  problem?: unknown;
  /** The job the worker is working on, or null when idle. */
  currentJobId?: unknown;
}

export interface ProgressInput {
  stage?: unknown;
  progress?: unknown;
  message?: unknown;
}

/** What the worker gets when it claims a job. */
export interface ClaimedJob {
  id: number;
  kind: WorkerJobKind;
  bookTitle: string | null;
  /** The audio file's own name (only its extension matters; the worker uses ASCII names). */
  audioFileName?: string;
  audioSize?: number;
  epubSize?: number | null;
  /** WP17 kinds: what the TTS run needs (tts-jobs.ts). */
  tts?: unknown;
  /** Report at least this often (seconds), or the job goes back to the queue. */
  leaseSeconds: number;
}

const MAX_TEXT = 2000;
const MAX_LOG_TAIL = 8000;

const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/**
 * A SubPlz result the server accepts: UTF-8 (a BOM is fine) with at least one SRT cue.
 * Returns the text without the BOM, or an error message.
 */
export function checkSrt(buf: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, error: 'The subtitle file is not UTF-8 text' };
  }
  const body = decoded.replace(/^\uFEFF/, '');
  if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(body)) {
    return { ok: false, error: 'The subtitle file has no subtitles in it' };
  }
  return { ok: true, text: body };
}

export interface SubtitleJobOptions {
  db: Database.Database;
  scan: AudioScanService;
  writer: AudioWriter;
  config: WorkerConfig;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
  now?: () => number;
}

export class SubtitleJobService {
  private readonly db: Database.Database;
  private readonly scan: AudioScanService;
  private readonly writer: AudioWriter;
  readonly config: WorkerConfig;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly now: () => number;
  /** Results being saved (a second upload of the same job waits for none, it is refused). */
  private readonly saving = new Set<number>();
  /** WP17: handlers of the other job kinds. */
  private readonly kinds = new Map<WorkerJobKind, WorkerKindHandler>();

  constructor(opts: SubtitleJobOptions) {
    this.db = opts.db;
    this.scan = opts.scan;
    this.writer = opts.writer;
    this.config = opts.config;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- reading

  /** WP17: a handler for job kinds other than 'sync_subtitles'. */
  registerKind(kinds: WorkerJobKind[], handler: WorkerKindHandler): void {
    for (const k of kinds) this.kinds.set(k, handler);
  }

  /** WP17: server-side work on a running job (its lease doesn't run out meanwhile). */
  holdSaving(id: number, on: boolean): void {
    if (on) this.saving.add(id);
    else this.saving.delete(id);
  }

  get(id: number): WorkerJob | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  latestForBook(
    userId: string,
    bookId: string,
    kinds: WorkerJobKind[] = ['sync_subtitles'],
  ): WorkerJob | null {
    this.expireLeases();
    const row = this.db
      .prepare(
        `${JOB_SELECT} WHERE j.user_id = ? AND j.book_id = ?
         AND j.kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY j.id DESC LIMIT 1`,
      )
      .get(userId, bookId, ...kinds) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  private statusRow(): {
    paused: number;
    last_seen_at: number | null;
    worker_version: string | null;
    image: string | null;
    tts_image: string | null;
    problem: string | null;
  } {
    return (
      (this.db.prepare('SELECT * FROM worker_status WHERE id = 1').get() as
        | {
            paused: number;
            last_seen_at: number | null;
            worker_version: string | null;
            image: string | null;
            tts_image: string | null;
            problem: string | null;
          }
        | undefined) ?? {
        paused: 0,
        last_seen_at: null,
        worker_version: null,
        image: null,
        tts_image: null,
        problem: null,
      }
    );
  }

  isPaused(): boolean {
    return this.statusRow().paused === 1;
  }

  status(userId: string): WorkerStatus {
    this.expireLeases();
    const s = this.statusRow();
    const jobs = (
      this.db
        .prepare(
          `${JOB_SELECT} WHERE j.user_id = ? AND j.state IN ('queued', 'running')
           ORDER BY (j.state = 'running') DESC, j.id`,
        )
        .all(userId) as JobRow[]
    ).map(toJob);
    return {
      online:
        s.last_seen_at !== null && this.now() - s.last_seen_at <= this.config.offlineSeconds * 1000,
      lastSeenAt: s.last_seen_at,
      paused: s.paused === 1,
      version: s.worker_version,
      image: s.image,
      ttsImage: s.tts_image,
      problem: s.problem,
      jobs,
    };
  }

  setPaused(paused: boolean): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO worker_status (id, paused, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
      )
      .run(paused ? 1 : 0, now);
    this.log(`GPU worker: ${paused ? 'paused' : 'resumed'} from Settings`);
  }

  // ---------------------------------------------------------------- queuing

  /** Subtitle files of the archive that look like this book's (best first). */
  archiveMatches(bookId: string, libraryId: string, limit = 3): SubtitleSummary[] {
    const book = this.db
      .prepare(
        `SELECT b.title, b.series_index, se.name AS series_name
         FROM books b LEFT JOIN series se ON se.id = b.series_id WHERE b.id = ?`,
      )
      .get(bookId) as
      | { title: string; series_index: number | null; series_name: string | null }
      | undefined;
    if (!book) return [];
    return rankEntries(
      {
        title: book.title,
        seriesName: book.series_name,
        seriesIndex: book.series_name ? book.series_index : null,
      },
      listSubtitleFiles(this.db, libraryId).map((s) => ({ ...s, fileCount: 1 })),
      limit,
    )
      .filter((s) => s.score >= this.config.archiveMatchMin)
      .map((s) => subtitleSummary(s.entry));
  }

  /**
   * Queues "make subtitles" for the user's book: needs a link to one audio file that is
   * there, the book's EPUB, and a subtitle folder for the audiobook's library. Unless
   * `force`, an archive file that looks like the book's is offered first (409).
   */
  enqueue(userId: string, bookId: string, { force = false }: { force?: boolean } = {}): WorkerJob {
    if (!this.scan.status.enabled) {
      throw new JobRequestError(503, 'audio_off', "The server's audiobooks folder isn't available");
    }
    const link = getLink(this.db, userId, bookId);
    const resolved = link ? resolveLink(this.db, link) : null;
    if (!link || !resolved || link.state !== 'linked' || link.folderRelPath === null) {
      throw new JobRequestError(409, 'no_audiobook', 'Link an audiobook to this book first');
    }
    if (!resolved.playable || link.fileName === null) {
      throw new JobRequestError(
        409,
        'not_playable',
        'Link one audio file first (choose a file or merge the files into one)',
      );
    }
    const folder = getAudioFolderByRelPath(this.db, link.folderRelPath) as AudioFolder;
    const lib = getLibrary(this.db, folder.libraryId);
    if (!lib?.srtArchivePath || !this.writer.generatedRoots(lib.id).subtitles) {
      throw new JobRequestError(
        409,
        'no_subtitle_dir',
        "This audiobook's library has no subtitle folder on the server",
      );
    }
    const epub = getBookFileFor(this.db, { id: userId }, bookId);
    if (!epub || epub.missing) {
      throw new JobRequestError(409, 'no_epub', "This book's EPUB is not available on the server");
    }
    if (!force) {
      const matches = this.archiveMatches(bookId, lib.id);
      if (matches.length > 0) {
        throw new JobRequestError(
          409,
          'archive_match',
          'The subtitle archive may already have subtitles for this book',
          { candidates: matches },
        );
      }
    }
    const now = this.now();
    const id = this.db.transaction(() => {
      const busy = this.db
        .prepare(
          `SELECT 1 FROM worker_jobs WHERE user_id = ? AND book_id = ? AND kind = 'sync_subtitles'
           AND state IN ('queued', 'running')`,
        )
        .get(userId, bookId);
      if (busy) {
        throw new JobRequestError(409, 'busy', 'Subtitles are being made for this book already');
      }
      return Number(
        this.db
          .prepare(
            `INSERT INTO worker_jobs (user_id, book_id, kind, library_id, audio_folder_rel_path,
               audio_file_name, link_confirmed_at, state, created_at, updated_at)
             VALUES (?, ?, 'sync_subtitles', ?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            userId,
            bookId,
            lib.id,
            link.folderRelPath,
            link.fileName,
            link.confirmedAt,
            now,
            now,
          ).lastInsertRowid,
      );
    })();
    this.log(`GPU worker: subtitles queued for book ${bookId} (job ${id})`);
    return this.get(id)!;
  }

  /** Stops a waiting job at once; a running one is stopped by the worker at its next report. */
  cancel(userId: string, id: number): WorkerJob | null {
    this.expireLeases();
    const job = this.get(id);
    if (!job || job.userId !== userId) return null;
    if (job.state === 'queued') {
      this.update(id, { state: 'cancelled', finished_at: this.now(), lease_expires_at: null });
      this.log(`GPU worker: job ${id} cancelled while waiting`);
    } else if (job.state === 'running' && !job.cancelRequested) {
      this.update(id, { cancel_requested: 1 });
      this.log(`GPU worker: job ${id} asked to stop`);
    }
    return this.get(id);
  }

  /** Sets columns of a job (and updated_at). */
  update(id: number, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(
        `UPDATE worker_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      )
      .run(...keys.map((k) => fields[k]), this.now(), id);
  }

  // ---------------------------------------------------------------- the worker

  /**
   * Running jobs whose worker went quiet: back to the queue, or failed after
   * WORKER_MAX_ATTEMPTS (a stopped one is just cancelled).
   */
  expireLeases(): void {
    const now = this.now();
    const expired = this.db
      .prepare(
        `SELECT id, kind, attempts, cancel_requested FROM worker_jobs
         WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(now) as {
      id: number;
      kind: WorkerJobKind;
      attempts: number;
      cancel_requested: number;
    }[];
    for (const j of expired) {
      if (this.saving.has(j.id)) continue;
      this.requeueOrFail(j, 'The PC stopped responding during the job');
    }
  }

  private requeueOrFail(
    j: { id: number; kind?: WorkerJobKind; attempts: number; cancel_requested: number },
    why: string,
  ): void {
    const now = this.now();
    // WP17: a long job that made progress since it was handed out doesn't lose an attempt.
    const handler = j.kind ? this.kinds.get(j.kind) : undefined;
    if (handler?.countsAsAttempt && j.cancel_requested !== 1) {
      const job = this.get(j.id);
      if (job && !handler.countsAsAttempt(job)) {
        j = { ...j, attempts: Math.max(0, j.attempts - 1) };
        this.update(j.id, { attempts: j.attempts });
      }
    }
    if (j.cancel_requested === 1) {
      this.update(j.id, { state: 'cancelled', finished_at: now, lease_expires_at: null });
      this.log(`GPU worker: job ${j.id} stopped`);
    } else if (j.attempts >= this.config.maxAttempts) {
      this.update(j.id, {
        state: 'failed',
        error: `${why} (${j.attempts} ${j.attempts === 1 ? 'time' : 'times'}).`,
        finished_at: now,
        lease_expires_at: null,
      });
      this.logError(`GPU worker: job ${j.id} failed: ${why}, ${j.attempts} attempt(s)`);
    } else {
      this.update(j.id, {
        state: 'queued',
        stage: null,
        progress: null,
        message: `${why}; it will be tried again.`,
        lease_expires_at: null,
      });
      this.log(`GPU worker: job ${j.id} back in the queue (${why})`);
    }
  }

  /** The worker's regular check-in when idle (also says whether it is paused). */
  heartbeat(input: HeartbeatInput): { paused: boolean; pollSeconds: number } {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO worker_status (id, paused, last_seen_at, worker_version, image, tts_image, problem, updated_at)
         VALUES (1, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
           worker_version = excluded.worker_version, image = excluded.image,
           tts_image = excluded.tts_image, problem = excluded.problem,
           updated_at = excluded.updated_at`,
      )
      .run(
        now,
        text(input.version, 100),
        text(input.image, 300),
        text(input.ttsImage, 300),
        text(input.problem, 500),
        now,
      );
    // A worker that says it is idle has lost any job it was holding (the PC restarted).
    const current =
      typeof input.currentJobId === 'number' && Number.isInteger(input.currentJobId)
        ? input.currentJobId
        : null;
    const orphans = this.db
      .prepare(
        `SELECT id, kind, attempts, cancel_requested FROM worker_jobs WHERE state = 'running' AND id IS NOT ?`,
      )
      .all(current) as {
      id: number;
      kind: WorkerJobKind;
      attempts: number;
      cancel_requested: number;
    }[];
    for (const j of orphans) {
      if (this.saving.has(j.id)) continue;
      this.requeueOrFail(j, 'The worker restarted during the job');
    }
    this.expireLeases();
    return { paused: this.isPaused(), pollSeconds: this.config.pollSeconds };
  }

  /** The next job for the worker, or null (paused, nothing waiting, or one is running). */
  claim(): ClaimedJob | null {
    this.db.prepare('UPDATE worker_status SET last_seen_at = ? WHERE id = 1').run(this.now());
    this.expireLeases();
    if (this.isPaused()) return null;
    return this.db.transaction((): ClaimedJob | null => {
      const running = this.db.prepare("SELECT 1 FROM worker_jobs WHERE state = 'running'").get();
      if (running) return null;
      const rows = this.db
        .prepare(`${JOB_SELECT} WHERE j.state = 'queued' ORDER BY j.id`)
        .all() as JobRow[];
      for (const row of rows) {
        if (row.kind !== 'sync_subtitles') {
          const handler = this.kinds.get(row.kind);
          const prepared = handler
            ? handler.claim(toJob(row))
            : { error: 'This server cannot run this kind of job' };
          if ('error' in prepared) {
            this.update(row.id, {
              state: 'failed',
              error: prepared.error,
              finished_at: this.now(),
            });
            this.log(`GPU worker: job ${row.id} failed before it started: ${prepared.error}`);
            continue;
          }
          const now = this.now();
          this.update(row.id, {
            state: 'running',
            stage: 'preparing',
            message: null,
            attempts: row.attempts + 1,
            claim_chapters: row.chapters_done,
            lease_expires_at: now + this.config.leaseSeconds * 1000,
            started_at: row.started_at ?? now,
            error: null,
          });
          this.log(
            `GPU worker: job ${row.id} (${row.kind}) handed to the worker (attempt ${row.attempts + 1})`,
          );
          return {
            id: row.id,
            kind: row.kind,
            bookTitle: row.book_title,
            tts: prepared.tts,
            leaseSeconds: this.config.leaseSeconds,
          };
        }
        const files = this.jobFiles(toJob(row));
        if ('error' in files) {
          this.update(row.id, { state: 'failed', error: files.error, finished_at: this.now() });
          this.log(`GPU worker: job ${row.id} failed before it started: ${files.error}`);
          continue;
        }
        const now = this.now();
        this.update(row.id, {
          state: 'running',
          stage: 'downloading',
          progress: 0,
          message: null,
          attempts: row.attempts + 1,
          lease_expires_at: now + this.config.leaseSeconds * 1000,
          started_at: row.started_at ?? now,
          error: null,
        });
        this.log(`GPU worker: job ${row.id} handed to the worker (attempt ${row.attempts + 1})`);
        return {
          id: row.id,
          kind: row.kind,
          bookTitle: row.book_title,
          audioFileName: row.audio_file_name!,
          audioSize: files.audio.size,
          epubSize: files.epubSize,
          leaseSeconds: this.config.leaseSeconds,
        };
      }
      return null;
    })();
  }

  /** The job's two inputs as they are now, or why the job can't run. */
  private jobFiles(
    job: WorkerJob,
  ):
    | { folder: AudioFolder; index: number; audio: { size: number }; epubSize: number | null }
    | { error: string } {
    if (job.kind !== 'sync_subtitles' || !job.audioFolderRelPath || !job.bookId) {
      return { error: 'Not a subtitle job' };
    }
    const folder = getAudioFolderByRelPath(this.db, job.audioFolderRelPath);
    if (!folder || folder.missingAt !== null) {
      return { error: 'The audiobook is no longer in the audiobooks folder' };
    }
    const index = folder.files.findIndex((f) => f.name === job.audioFileName);
    if (index < 0) return { error: 'The audio file is no longer in its folder' };
    const epub = getBookFileFor(this.db, { id: job.userId }, job.bookId);
    if (!epub || epub.missing) return { error: "The book's EPUB is no longer available" };
    return { folder, index, audio: { size: folder.files[index].size }, epubSize: epub.fileSize };
  }

  /** The running job the worker may read files of, or an error for the route. */
  heldJob(id: number): {
    job: WorkerJob;
    folder: AudioFolder;
    index: number;
  } {
    const job = this.get(id);
    if (!job) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running') {
      throw new JobRequestError(409, 'not_running', 'This job is not running');
    }
    if (job.cancelRequested) {
      throw new JobRequestError(409, 'cancelled', 'This job was stopped');
    }
    const files = this.jobFiles(job);
    if ('error' in files) throw new JobRequestError(410, 'missing', files.error);
    return { job, folder: files.folder, index: files.index };
  }

  /**
   * A progress report; extends the lease. `cancel` tells the worker to stop; `pause` (WP17)
   * that the pause switch is on (a long job stops after its current chapter).
   */
  progress(id: number, input: ProgressInput): { cancel: boolean; pause: boolean } {
    this.expireLeases();
    const job = this.get(id);
    if (!job) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running') return { cancel: true, pause: false };
    const stage = WORKER_STAGES.includes(input.stage as WorkerJobStage)
      ? (input.stage as WorkerJobStage)
      : job.stage;
    const p =
      typeof input.progress === 'number' && Number.isFinite(input.progress)
        ? Math.min(1, Math.max(0, input.progress))
        : null;
    this.update(id, {
      stage,
      progress: p,
      message: text(input.message, 300),
      lease_expires_at: this.now() + this.config.leaseSeconds * 1000,
    });
    this.db.prepare('UPDATE worker_status SET last_seen_at = ? WHERE id = 1').run(this.now());
    return { cancel: job.cancelRequested, pause: this.isPaused() };
  }

  /** WP17: the worker paused between chapters: back to the queue, no attempt used. */
  release(id: number): WorkerJob {
    const job = this.get(id);
    if (!job) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running' || this.saving.has(id)) return job;
    if (job.cancelRequested) return this.fail(id, {});
    this.update(id, {
      state: 'queued',
      stage: null,
      message: 'Paused; it continues when the PC is resumed.',
      attempts: Math.max(0, job.attempts - 1),
      lease_expires_at: null,
    });
    this.log(`GPU worker: job ${id} paused between chapters`);
    return this.get(id)!;
  }

  /** The worker gave up (or stopped on request). */
  fail(id: number, input: { error?: unknown; logTail?: unknown }): WorkerJob {
    const job = this.get(id);
    if (!job) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running' || this.saving.has(id)) return job;
    const now = this.now();
    if (job.cancelRequested) {
      this.update(id, { state: 'cancelled', finished_at: now, lease_expires_at: null });
      this.log(`GPU worker: job ${id} stopped`);
    } else {
      const error = this.plain(text(input.error) ?? 'The worker could not finish the job');
      this.update(id, {
        state: 'failed',
        error,
        log_tail: text(input.logTail, MAX_LOG_TAIL),
        finished_at: now,
        lease_expires_at: null,
      });
      this.logError(`GPU worker: job ${id} failed: ${error}`);
    }
    return this.get(id)!;
  }

  /**
   * The finished subtitle file: checked, saved into `<subtitle folder>/_generated/` (a new
   * file, named after the book), indexed, and linked to the book if its link is unchanged.
   */
  async result(id: number, body: Buffer): Promise<WorkerJob> {
    this.expireLeases();
    const job = this.get(id);
    if (!job) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running' || this.saving.has(id) || job.kind !== 'sync_subtitles') {
      throw new JobRequestError(409, 'not_running', 'This job is not running');
    }
    if (job.cancelRequested) {
      this.fail(id, {});
      throw new JobRequestError(409, 'cancelled', 'This job was stopped; nothing was saved');
    }
    const checked = checkSrt(body);
    if (!checked.ok) {
      this.fail(id, { error: checked.error });
      throw new JobRequestError(400, 'invalid_result', checked.error);
    }
    this.saving.add(id);
    try {
      this.update(id, {
        stage: 'saving',
        progress: null,
        lease_expires_at: this.now() + this.config.leaseSeconds * 1000,
      });
      const title = job.bookTitle ?? (job.audioFileName ?? 'subtitles').replace(/\.[^.]+$/, '');
      const [first, ...fallbackNames] = subtitleNameCandidates(title, job.bookId!);
      let saved: { name: string; relPath: string };
      try {
        saved = await this.writer.createGeneratedFile({
          libraryId: job.libraryId!,
          area: 'subtitles',
          relPath: first,
          fallbackNames,
          source: Buffer.from(checked.text, 'utf8'),
        });
      } catch (err) {
        const error = `Could not save the subtitles: ${this.plain((err as Error).message)}`;
        this.update(id, {
          state: 'failed',
          error,
          finished_at: this.now(),
          lease_expires_at: null,
        });
        this.logError(`GPU worker: job ${id} failed: ${error}`);
        return this.get(id)!;
      }
      this.update(id, { output_rel_path: saved.relPath });
      let indexed = false;
      try {
        indexed = await this.scan.rescanSubtitleFile(job.libraryId!, saved.relPath);
      } catch (err) {
        this.logError(`GPU worker: could not index ${saved.name}:`, err);
      }
      const linked = indexed && this.autoLink(job, saved.relPath);
      this.update(id, {
        state: 'done',
        stage: null,
        progress: 1,
        linked: linked ? 1 : 0,
        finished_at: this.now(),
        lease_expires_at: null,
      });
      this.log(`GPU worker: job ${id} saved ${saved.relPath}${linked ? ' (linked)' : ''}`);
      return this.get(id)!;
    } finally {
      this.saving.delete(id);
    }
  }

  /** Links the new subtitles only if the book's link is the one the job was queued with. */
  private autoLink(job: WorkerJob, subtitleRelPath: string): boolean {
    const queuedWith = (
      this.db.prepare('SELECT link_confirmed_at FROM worker_jobs WHERE id = ?').get(job.id) as {
        link_confirmed_at: number | null;
      }
    ).link_confirmed_at;
    const current = getLink(this.db, job.userId, job.bookId!);
    if (
      !current ||
      current.state !== 'linked' ||
      current.confirmedAt !== queuedWith ||
      current.folderRelPath !== job.audioFolderRelPath ||
      current.fileName !== job.audioFileName
    ) {
      return false;
    }
    saveLink(this.db, job.userId, {
      ...current,
      subtitleState: 'linked',
      subtitleRelPath,
      confirmedAt: this.now(),
    });
    return true;
  }

  /** An error for the page: no server folders. */
  private plain(message: string): string {
    return shortenPaths(message, [this.scan.root]);
  }
}
