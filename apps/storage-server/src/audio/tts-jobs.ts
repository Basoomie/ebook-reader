/**
 * WP17: generated audiobooks on the GPU worker (decided with the user, 2026-11-12; see
 * decisions.md "Generated audiobooks: WP17 decisions"). Three job kinds share the WP16
 * queue (subtitle-jobs.ts: one job at a time, lease, pause switch, Stop):
 *
 * - 'generate_audiobook': the whole book, chapter by chapter. The worker uploads each
 *   chapter (FLAC, with the exact start/end of every sentence) as soon as it is done; the
 *   server keeps them in CACHE_DIR/tts/<job>/ and records them (tts_job_chapters), so a job
 *   that is paused or interrupted (PC off) continues with the next chapter. When the last
 *   chapter arrives the server puts the book together: one m4b (AAC, one chapter marker per
 *   EPUB chapter, tags, cover) and an .srt built from the exact timings (sentence text as
 *   shown in the reader, so whispersync's match finds every line), saved through the
 *   guarded writer into a NEW folder `<audio folder>-generated/<Author>/<Title>/` (later
 *   versions `<Title> (v2)/`, …), indexed, and linked to the book if its link is unchanged
 *   since the job was started (the user started it from that book).
 * - 'preview_audiobook': about a minute of one chapter, kept in the cache for the book page.
 * - 'voice_sample': "Describe a voice": one ~20 s sample in one model call; kept as a voice
 *   preset only when the user keeps it.
 *
 * Every job records its settings as the voice map v1: { mapVersion: 1, narrator, model,
 * seed, pauses }. The text comes from the reader's own import (book-script.ts).
 */
import type Database from 'better-sqlite3';
import { createHash, randomInt } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getLibrary } from '../calibre/libraries';
import { resolveInside, statFile } from '../calibre/source-fs';
import { getBookFileFor } from '../catalog/queries';
import type { AudioMergeConfig, TtsConfig } from '../config';
import type { UploadStore } from '../uploads/upload-store';
import type { VoiceService } from '../voices/voice-service';
import { getLink, saveLink } from './audio-links';
import { type AudioWriter, safeBaseName } from './audio-write';
import {
  type BookScript,
  previewSentences,
  readBookScript,
  type ScriptChapter,
  type ScriptReader,
} from './book-script';
import { buildConcatList, shortenPaths } from './merge-service';
import type { AudioScanService } from './scan-service';
import {
  JobRequestError,
  type SubtitleJobService,
  type WorkerJob,
  type WorkerJobKind,
} from './subtitle-jobs';
import { probeFile, runTool } from './tool-run';
import type { TtsModel, TtsModelService } from './tts-models';
import { TooLargeError, TtsWorkdir } from './tts-workdir';

export const TTS_KINDS: WorkerJobKind[] = [
  'generate_audiobook',
  'preview_audiobook',
  'voice_sample',
];

/** What "Describe a voice" reads (neutral narration, ~20 s). */
export const VOICE_SAMPLE_TEXT =
  'こんばんは。今夜も、一冊の本をゆっくりと読んでいきます。' +
  '静かな部屋で、温かいお茶でも飲みながら、どうぞ楽な姿勢でお聴きください。' +
  '物語の中の人たちが、それぞれの思いを抱えて、少しずつ動き出します。' +
  'それでは、最初のページを開きましょう。';

export interface Pauses {
  sentenceMs: number;
  paragraphMs: number;
  chapterMs: number;
}

export const DEFAULT_PAUSES: Pauses = { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 };

/** The voice map, v1: one narrator (later versions add dialogue and character voices). */
export interface VoiceMapV1 {
  mapVersion: 1;
  narrator: {
    voiceId: string | null;
    name: string;
    kind: 'clip' | 'design' | 'description';
    sha256: string | null;
    description: string | null;
  };
  model: { id: number; source: string; revision: string; label: string };
  seed: number;
  pauses: Pauses;
  /** Preview: the chapter read. */
  chapterIndex?: number;
  chapterTitle?: string;
}

/** What the worker gets for a TTS job when it claims it. */
export interface TtsClaim {
  kind: WorkerJobKind;
  model: { source: string; revision: string };
  /** The reference clip to copy (GET …/voice), or null (a described voice sample). */
  voice: { sha256: string; seconds: number } | null;
  /** A voice description (voice samples only). */
  caption: string | null;
  seed: number;
  pauses: Pauses;
  /** Read the whole text in one model call (a voice sample: one voice throughout). */
  whole: boolean;
  chaptersTotal: number;
  chaptersDone: number;
}

export interface CueInput {
  durationMs?: unknown;
  cues?: unknown;
  spoken?: unknown;
}

interface ChapterRow {
  job_id: number;
  idx: number;
  title: string;
  duration_ms: number;
  cues: string;
  part_file: string;
  bytes: number;
  done_at: number;
}

export interface TtsJobOptions {
  db: Database.Database;
  jobs: SubtitleJobService;
  scan: AudioScanService;
  writer: AudioWriter;
  models: TtsModelService;
  voices: VoiceService | null;
  config: TtsConfig;
  tools: Pick<AudioMergeConfig, 'ffmpegPath' | 'ffprobePath' | 'minFreeMb' | 'stallMinutes'>;
  /** CACHE_DIR: chapter parts, previews and samples go to CACHE_DIR/tts/<job>/. */
  cacheDir: string;
  calibreDir: string | null;
  uploads: UploadStore | null;
  /** The reader's import settings (as the character counter uses them). */
  importOptions: unknown;
  readScript?: ScriptReader;
  now?: () => number;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const MAX_SPOKEN = 2000;

export function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const r = t % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`;
}

/** The .srt of a generated book: one cue per sentence, times from the generation. */
export function buildSrt(
  chapters: { durationMs: number; cues: [number, number][]; texts: string[] }[],
): string {
  const lines: string[] = [];
  let offset = 0;
  let n = 0;
  for (const ch of chapters) {
    ch.cues.forEach(([start, end], i) => {
      n += 1;
      const text = ch.texts[i].replace(/\r?\n/g, ' ');
      lines.push(String(n), `${srtTime(offset + start)} --> ${srtTime(offset + end)}`, text, '');
    });
    offset += ch.durationMs;
  }
  return lines.join('\n');
}

function metaEscape(s: string): string {
  return s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? '\\\n' : `\\${c}`));
}

/** The m4b's chapter and tag file. */
export function buildTtsFfmetadata(
  tags: Record<string, string>,
  chapters: { title: string; durationMs: number }[],
): string {
  const lines = [';FFMETADATA1'];
  for (const [k, v] of Object.entries(tags)) if (v) lines.push(`${k}=${metaEscape(v)}`);
  let start = 0;
  for (const ch of chapters) {
    const end = start + Math.max(1, Math.round(ch.durationMs));
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`);
    lines.push(`title=${metaEscape(ch.title)}`);
    start = end;
  }
  return lines.join('\n') + '\n';
}

/** Folder names for a version: `<title>` (v1) or `<title> (vN)`, then later ones. */
export function versionFolderNames(title: string, version: number, count = 50): string[] {
  const base = safeBaseName(title).slice(0, 180);
  const names: string[] = [];
  for (let v = Math.max(1, version); v < Math.max(1, version) + count; v++) {
    names.push(v === 1 ? base : `${base} (v${v})`);
  }
  return names;
}

/** A seed that stays the same for a book and voice, so a preview sounds like the book. */
export function seedFor(bookId: string, voiceKey: string): number {
  return (
    createHash('sha256').update(`${bookId}|${voiceKey}`).digest().readUInt32BE(0) % 2_000_000_000
  );
}

function parsePauses(raw: unknown): Pauses {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ms = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(10_000, Math.max(0, Math.round(v))) : d;
  return {
    sentenceMs: ms(p.sentenceMs, DEFAULT_PAUSES.sentenceMs),
    paragraphMs: ms(p.paragraphMs, DEFAULT_PAUSES.paragraphMs),
    chapterMs: ms(p.chapterMs, DEFAULT_PAUSES.chapterMs),
  };
}

export class TtsJobService {
  readonly config: TtsConfig;
  private readonly db: Database.Database;
  private readonly jobs: SubtitleJobService;
  private readonly scan: AudioScanService;
  private readonly writer: AudioWriter;
  private readonly models: TtsModelService;
  private readonly voices: VoiceService | null;
  private readonly tools: TtsJobOptions['tools'];
  readonly workdir: TtsWorkdir;
  private readonly calibreDir: string | null;
  private readonly uploads: UploadStore | null;
  private readonly importOptions: unknown;
  private readonly readScript: ScriptReader;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  /** Assemblies running now (job ids). */
  private readonly assembling = new Map<number, Promise<void>>();
  /** Book chapter lists for the book page (per book file), short-lived. */
  private readonly chapterCache = new Map<string, { at: number; script: BookScript }>();

  constructor(opts: TtsJobOptions) {
    this.db = opts.db;
    this.jobs = opts.jobs;
    this.scan = opts.scan;
    this.writer = opts.writer;
    this.models = opts.models;
    this.voices = opts.voices;
    this.config = opts.config;
    this.tools = opts.tools;
    this.workdir = new TtsWorkdir(opts.cacheDir, opts.scan.root);
    this.calibreDir = opts.calibreDir;
    this.uploads = opts.uploads;
    this.importOptions = opts.importOptions;
    this.readScript = opts.readScript ?? readBookScript;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.jobs.registerKind(TTS_KINDS, {
      claim: (job) => this.prepareClaim(job),
      countsAsAttempt: (job) => {
        const row = this.db
          .prepare('SELECT claim_chapters, chapters_done FROM worker_jobs WHERE id = ?')
          .get(job.id) as { claim_chapters: number | null; chapters_done: number } | undefined;
        return !row || row.chapters_done <= (row.claim_chapters ?? 0);
      },
    });
  }

  // ---------------------------------------------------------------- start / housekeeping

  /** At start: finishes assemblies a stopped server left, and tidies the work folder. */
  async start(): Promise<void> {
    await this.workdir.ensure();
    const left = this.db
      .prepare(
        `SELECT id FROM worker_jobs WHERE kind = 'generate_audiobook' AND state = 'running'
           AND chapters_total IS NOT NULL AND chapters_done >= chapters_total`,
      )
      .all() as { id: number }[];
    for (const { id } of left) this.kickAssembly(id);
    await this.sweep();
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.assembling.values()]);
  }

  private jobDir(id: number): string {
    return this.workdir.jobDir(id);
  }

  private file(id: number, name: string): string {
    return this.workdir.file(id, name);
  }

  /**
   * Removes work folders that are no longer needed: everything of a finished, failed or
   * stopped audiobook job; previews and samples except the newest finished one per book
   * (per user for samples) and samples not kept within a day.
   */
  async sweep(): Promise<void> {
    const ids = await this.workdir.jobIds();
    const keep = new Set<number>();
    const rows = this.db
      .prepare(
        `SELECT id, user_id, book_id, kind, state, finished_at FROM worker_jobs
         WHERE kind IN ('generate_audiobook', 'preview_audiobook', 'voice_sample')`,
      )
      .all() as {
      id: number;
      user_id: string;
      book_id: string | null;
      kind: WorkerJobKind;
      state: string;
      finished_at: number | null;
    }[];
    const newest = new Map<string, number>();
    for (const r of rows) {
      if (r.state === 'queued' || r.state === 'running') keep.add(r.id);
      if (r.state === 'done' && r.kind !== 'generate_audiobook') {
        const key = `${r.kind}|${r.user_id}|${r.kind === 'voice_sample' ? '' : r.book_id}`;
        if ((newest.get(key) ?? 0) < r.id) newest.set(key, r.id);
      }
    }
    for (const r of rows) {
      if (
        newest.get(`${r.kind}|${r.user_id}|${r.kind === 'voice_sample' ? '' : r.book_id}`) !== r.id
      ) {
        continue;
      }
      if (r.kind === 'voice_sample' && (r.finished_at ?? 0) < this.now() - 86_400_000) continue;
      keep.add(r.id);
    }
    for (const id of ids) {
      if (keep.has(id)) continue;
      await this.workdir.removeJob(id).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- the book's text

  /** The EPUB on disk (read-only), or null. */
  private epubFile(userId: string, bookId: string): string | null {
    const loc = getBookFileFor(this.db, { id: userId }, bookId);
    if (!loc || loc.missing) return null;
    try {
      if (loc.kind === 'upload') return this.uploads ? this.uploads.resolve(loc.filePath) : null;
      if (!this.calibreDir) return null;
      return resolveInside(path.join(this.calibreDir, loc.libraryFolder), loc.filePath);
    } catch {
      return null;
    }
  }

  /** The cover next to a Calibre book's EPUB (cover.jpg), or null. */
  private async coverFile(userId: string, bookId: string): Promise<string | null> {
    const loc = getBookFileFor(this.db, { id: userId }, bookId);
    if (!loc || loc.kind !== 'calibre' || !this.calibreDir) return null;
    try {
      const dir = path.posix.dirname(loc.filePath);
      const file = resolveInside(
        path.join(this.calibreDir, loc.libraryFolder),
        dir === '.' ? 'cover.jpg' : `${dir}/cover.jpg`,
      );
      return (await statFile(file)) ? file : null;
    } catch {
      return null;
    }
  }

  private async bookScript(userId: string, bookId: string): Promise<BookScript> {
    const file = this.epubFile(userId, bookId);
    if (!file) {
      throw new JobRequestError(409, 'no_epub', "This book's EPUB is not available on the server");
    }
    const st = await statFile(file);
    const key = `${file}|${st?.size}|${st?.mtimeMs}`;
    const cached = this.chapterCache.get(key);
    if (cached && this.now() - cached.at < 10 * 60_000) return cached.script;
    let script: BookScript;
    try {
      script = await this.readScript(file, {
        importOptions: this.importOptions,
        maxSentence: this.config.maxSentence,
        timeoutMs: this.config.scriptTimeoutSeconds * 1000,
      });
    } catch (err) {
      throw new JobRequestError(422, 'unreadable', this.plain((err as Error).message));
    }
    if (!script.chapters.length) {
      throw new JobRequestError(422, 'no_text', 'This book has no text to read');
    }
    this.chapterCache.clear();
    this.chapterCache.set(key, { at: this.now(), script });
    return script;
  }

  /** The book's chapters for the book page (title, characters). */
  async chapters(userId: string, bookId: string) {
    const script = await this.bookScript(userId, bookId);
    return {
      characters: script.characters,
      chapters: script.chapters.map((c) => ({
        index: c.index,
        title: c.title,
        characters: c.characters,
        sentences: c.sentences.length,
      })),
    };
  }

  // ---------------------------------------------------------------- starting jobs

  private chooseModel(modelId: unknown): TtsModel {
    const model =
      typeof modelId === 'number' ? this.models.get(modelId) : this.models.defaultModel();
    if (!model || model.removedAt !== null) {
      throw new JobRequestError(409, 'no_model', 'Choose a model from the list in Settings');
    }
    return model;
  }

  private chooseVoice(userId: string, voiceId: unknown, model: TtsModel) {
    if (!this.voices)
      throw new JobRequestError(503, 'voices_off', 'Voice presets are off on this server');
    const voice = typeof voiceId === 'string' ? this.voices.get(userId, voiceId) : null;
    if (!voice) throw new JobRequestError(409, 'no_voice', 'Choose a voice');
    if (model.supportsClip === false) {
      throw new JobRequestError(409, 'model_no_clip', `${model.label} can't copy a voice preset`);
    }
    return voice;
  }

  private activeFor(userId: string, bookId: string, kind: WorkerJobKind): WorkerJob | null {
    const row = this.db
      .prepare(
        `SELECT id FROM worker_jobs WHERE user_id = ? AND book_id = ? AND kind = ?
           AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
      )
      .get(userId, bookId, kind) as { id: number } | undefined;
    return row ? this.jobs.get(row.id) : null;
  }

  private insertJob(fields: {
    userId: string;
    bookId: string | null;
    kind: WorkerJobKind;
    libraryId: string | null;
    linkConfirmedAt: number | null;
    params: VoiceMapV1;
    version: number | null;
    chaptersTotal: number;
  }): number {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO worker_jobs (user_id, book_id, kind, library_id, link_confirmed_at, state,
             params, version, chapters_total, chapters_done, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          fields.userId,
          fields.bookId,
          fields.kind,
          fields.libraryId,
          fields.linkConfirmedAt,
          JSON.stringify(fields.params),
          fields.version,
          fields.chaptersTotal,
          now,
          now,
        ).lastInsertRowid,
    );
  }

  private async writeScript(id: number, chapters: ScriptChapter[]): Promise<void> {
    await this.workdir.writeText(id, 'script.json', JSON.stringify({ chapters }));
  }

  private async readJobScript(id: number): Promise<ScriptChapter[]> {
    const raw = await fs.readFile(this.file(id, 'script.json'), 'utf8');
    return (JSON.parse(raw) as { chapters: ScriptChapter[] }).chapters;
  }

  private bookLibrary(bookId: string): string | null {
    const row = this.db.prepare('SELECT library_id FROM books WHERE id = ?').get(bookId) as
      | { library_id: string }
      | undefined;
    return row?.library_id ?? null;
  }

  private nextVersion(userId: string, bookId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(version) AS v FROM worker_jobs WHERE user_id = ? AND book_id = ?
           AND kind = 'generate_audiobook' AND state = 'done'`,
      )
      .get(userId, bookId) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  private voiceMap(
    voice: {
      id: string;
      name: string;
      kind: 'clip' | 'design';
      sha256: string;
      description: string | null;
    },
    model: TtsModel,
    bookId: string,
    pauses: Pauses,
  ): VoiceMapV1 {
    return {
      mapVersion: 1,
      narrator: {
        voiceId: voice.id,
        name: voice.name,
        kind: voice.kind,
        sha256: voice.sha256,
        description: voice.description,
      },
      model: { id: model.id, source: model.source, revision: model.revision, label: model.label },
      seed: seedFor(bookId, voice.sha256),
      pauses,
    };
  }

  /** "Make an audiobook on the PC": the whole book, as a new version. */
  async startAudiobook(
    userId: string,
    bookId: string,
    input: { voiceId?: unknown; modelId?: unknown; pauses?: unknown },
  ): Promise<WorkerJob> {
    if (!this.scan.status.enabled) {
      throw new JobRequestError(503, 'audio_off', "The server's audiobooks folder isn't available");
    }
    const libraryId = this.bookLibrary(bookId);
    const lib = libraryId ? getLibrary(this.db, libraryId) : null;
    if (!lib || !this.writer.generatedRoots(lib.id).audio) {
      throw new JobRequestError(
        409,
        'no_audio_dir',
        "This book's library has no audiobooks folder on the server",
      );
    }
    const model = this.chooseModel(input.modelId);
    const voice = this.chooseVoice(userId, input.voiceId, model);
    if (this.activeFor(userId, bookId, 'generate_audiobook')) {
      throw new JobRequestError(409, 'busy', 'An audiobook is being made for this book already');
    }
    const script = await this.bookScript(userId, bookId);
    const link = getLink(this.db, userId, bookId);
    const id = this.insertJob({
      userId,
      bookId,
      kind: 'generate_audiobook',
      libraryId: lib.id,
      linkConfirmedAt: link?.confirmedAt ?? null,
      params: this.voiceMap(voice, model, bookId, parsePauses(input.pauses)),
      version: this.nextVersion(userId, bookId),
      chaptersTotal: script.chapters.length,
    });
    try {
      await this.writeScript(id, script.chapters);
    } catch (err) {
      this.jobs.update(id, {
        state: 'failed',
        error: 'Could not prepare the job',
        finished_at: this.now(),
      });
      throw err;
    }
    this.log(
      `GPU worker: audiobook queued for book ${bookId} (job ${id}, ${script.chapters.length} chapters)`,
    );
    return this.jobs.get(id)!;
  }

  /** "Preview": about a minute of one chapter with the chosen voice and model. */
  async startPreview(
    userId: string,
    bookId: string,
    input: { voiceId?: unknown; modelId?: unknown; pauses?: unknown; chapterIndex?: unknown },
  ): Promise<WorkerJob> {
    const model = this.chooseModel(input.modelId);
    const voice = this.chooseVoice(userId, input.voiceId, model);
    const script = await this.bookScript(userId, bookId);
    const wanted = typeof input.chapterIndex === 'number' ? input.chapterIndex : 0;
    const chapter = script.chapters.find((c) => c.index === wanted) ?? script.chapters[0];
    const sentences = previewSentences(chapter, this.config.previewSeconds);
    // A new preview replaces the one waiting.
    const waiting = this.activeFor(userId, bookId, 'preview_audiobook');
    if (waiting) this.jobs.cancel(userId, waiting.id);
    const params = {
      ...this.voiceMap(voice, model, bookId, parsePauses(input.pauses)),
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
    };
    const id = this.insertJob({
      userId,
      bookId,
      kind: 'preview_audiobook',
      libraryId: this.bookLibrary(bookId),
      linkConfirmedAt: null,
      params,
      version: null,
      chaptersTotal: 1,
    });
    await this.writeScript(id, [{ ...chapter, index: 0, sentences }]);
    this.log(`GPU worker: preview queued for book ${bookId} (job ${id})`);
    return this.jobs.get(id)!;
  }

  /** "Describe a voice": a ~20 s sample from a description, in one model call. */
  async startVoiceSample(
    userId: string,
    input: { name?: unknown; description?: unknown; modelId?: unknown },
  ): Promise<WorkerJob> {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    const description =
      typeof input.description === 'string' ? input.description.trim().slice(0, 300) : '';
    if (!name) throw new JobRequestError(400, 'invalid_name', 'Give the voice a name');
    if (!description) throw new JobRequestError(400, 'invalid_description', 'Describe the voice');
    let model = this.chooseModel(input.modelId);
    if (model.supportsDescription === false) {
      const other = this.models.list().find((m) => m.supportsDescription !== false);
      if (!other)
        throw new JobRequestError(
          409,
          'model_no_description',
          'No model in the list can describe a voice',
        );
      model = other;
    }
    const params: VoiceMapV1 = {
      mapVersion: 1,
      narrator: { voiceId: null, name, kind: 'description', sha256: null, description },
      model: { id: model.id, source: model.source, revision: model.revision, label: model.label },
      seed: randomInt(1, 2_000_000_000),
      pauses: { ...DEFAULT_PAUSES, chapterMs: 0 },
    };
    const id = this.insertJob({
      userId,
      bookId: null,
      kind: 'voice_sample',
      libraryId: null,
      linkConfirmedAt: null,
      params,
      version: null,
      chaptersTotal: 1,
    });
    await this.writeScript(id, [
      {
        index: 0,
        title: name,
        startCharacter: 0,
        characters: VOICE_SAMPLE_TEXT.length,
        sentences: [
          { text: VOICE_SAMPLE_TEXT, reading: VOICE_SAMPLE_TEXT, position: 0, paragraphEnd: true },
        ],
      },
    ]);
    this.log(`GPU worker: voice sample queued (job ${id})`);
    return this.jobs.get(id)!;
  }

  /** Keeps a finished voice sample as a preset. */
  async keepSample(userId: string, jobId: number) {
    if (!this.voices)
      throw new JobRequestError(503, 'voices_off', 'Voice presets are off on this server');
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId || job.kind !== 'voice_sample') {
      throw new JobRequestError(404, 'not_found', 'No such sample');
    }
    if (job.state !== 'done')
      throw new JobRequestError(409, 'not_ready', 'The sample is not ready');
    const params = job.params as unknown as VoiceMapV1;
    const sample = this.file(jobId, 'part-0000.flac');
    if (!(await statFile(sample)))
      throw new JobRequestError(410, 'gone', 'The sample is no longer there; make a new one');
    try {
      return await this.voices.addDesign(userId, sample, {
        name: params.narrator.name,
        description: params.narrator.description ?? '',
        modelSource: params.model.source,
        seed: params.seed,
      });
    } catch (err) {
      const e = err as { status?: number; code?: string; message: string };
      if (e.status && e.code) throw new JobRequestError(e.status, e.code, e.message);
      throw err;
    }
  }

  /** The audio of a finished preview or voice sample (FLAC in the work folder). */
  async resultFile(userId: string, jobId: number): Promise<string | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId || job.state !== 'done') return null;
    if (job.kind !== 'preview_audiobook' && job.kind !== 'voice_sample') return null;
    const file = this.file(jobId, 'part-0000.flac');
    return (await statFile(file)) ? file : null;
  }

  latest(userId: string, bookId: string, kind: WorkerJobKind): WorkerJob | null {
    return this.jobs.latestForBook(userId, bookId, [kind]);
  }

  latestSample(userId: string): WorkerJob | null {
    const row = this.db
      .prepare(
        `SELECT id FROM worker_jobs WHERE user_id = ? AND kind = 'voice_sample' ORDER BY id DESC LIMIT 1`,
      )
      .get(userId) as { id: number } | undefined;
    return row ? this.jobs.get(row.id) : null;
  }

  // ---------------------------------------------------------------- the worker

  private prepareClaim(job: WorkerJob): { tts: TtsClaim } | { error: string } {
    const params = job.params as unknown as VoiceMapV1 | null;
    if (!params || params.mapVersion !== 1) return { error: 'This job has no settings' };
    let voice: TtsClaim['voice'] = null;
    if (params.narrator.voiceId) {
      const v = this.voices?.byId(params.narrator.voiceId);
      if (!v) return { error: 'The voice preset of this job was deleted' };
      if (v.sha256 !== params.narrator.sha256)
        return { error: 'The voice preset of this job changed' };
      voice = { sha256: v.sha256, seconds: v.clipSeconds };
    }
    if (job.kind === 'generate_audiobook' && job.chaptersDone >= (job.chaptersTotal ?? 0)) {
      return { error: 'Nothing left to read' };
    }
    return {
      tts: {
        kind: job.kind,
        model: { source: params.model.source, revision: params.model.revision },
        voice,
        caption: job.kind === 'voice_sample' ? params.narrator.description : null,
        seed: params.seed,
        pauses: params.pauses,
        whole: job.kind === 'voice_sample',
        chaptersTotal: job.chaptersTotal ?? 0,
        chaptersDone: job.chaptersDone,
      },
    };
  }

  /** The running TTS job the worker may work on. */
  held(id: number): WorkerJob {
    const job = this.jobs.get(id);
    if (!job || !TTS_KINDS.includes(job.kind))
      throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running')
      throw new JobRequestError(409, 'not_running', 'This job is not running');
    if (job.cancelRequested) throw new JobRequestError(409, 'cancelled', 'This job was stopped');
    return job;
  }

  /** The worker paused after a chapter (pause switch): back to the queue, no attempt used. */
  release(id: number): WorkerJob {
    this.held(id);
    return this.jobs.release(id);
  }

  private doneChapters(id: number): ChapterRow[] {
    return this.db
      .prepare('SELECT * FROM tts_job_chapters WHERE job_id = ? ORDER BY idx')
      .all(id) as ChapterRow[];
  }

  /** The chapters still to read (text as shown, and the reading to speak). */
  async workerScript(id: number) {
    this.held(id);
    const done = new Set(this.doneChapters(id).map((c) => c.idx));
    const chapters = (await this.readJobScript(id)).filter((c) => !done.has(c.index));
    return {
      chapters: chapters.map((c) => ({
        index: c.index,
        title: c.title,
        sentences: c.sentences.map((s) => ({
          text: s.text,
          reading: s.reading,
          paragraphEnd: s.paragraphEnd,
        })),
      })),
    };
  }

  /** The reference clip of the job's voice (path inside the voice store). */
  voiceClip(id: number): { relative: string } {
    const job = this.held(id);
    const params = job.params as unknown as VoiceMapV1;
    if (!params.narrator.voiceId || !this.voices) {
      throw new JobRequestError(404, 'no_voice', 'This job has no voice clip');
    }
    return { relative: this.voices.clipRelative(params.narrator.voiceId) };
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
    const need = bytes + this.tools.minFreeMb * 1024 * 1024;
    if (free !== null && free < need) {
      const mb = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString('en-US')} MB`;
      throw new JobRequestError(
        507,
        'no_space',
        `Not enough free space in ${where}: ${mb(free)} free, ${mb(need)} needed`,
      );
    }
  }

  /** A chapter's audio (FLAC), streamed into the work folder; recorded by finishChapter. */
  async receiveChapter(
    id: number,
    idx: number,
    body: NodeJS.ReadableStream,
    declared: number | null,
  ) {
    const job = this.held(id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (job.chaptersTotal ?? 0)) {
      throw new JobRequestError(400, 'bad_chapter', 'No such chapter');
    }
    const max = Math.round(this.config.chapterMaxMb * 1024 * 1024);
    if (declared !== null && declared > max) {
      throw new JobRequestError(
        413,
        'too_large',
        `A chapter may be at most ${this.config.chapterMaxMb} MB`,
      );
    }
    await this.workdir.ensure(id);
    await this.requireFree(this.jobDir(id), declared ?? 0, "the server's cache folder");
    let size: number;
    try {
      size = await this.workdir.receive(
        id,
        `part-${String(idx).padStart(4, '0')}.upload`,
        body,
        max,
      );
    } catch (err) {
      if (err instanceof TooLargeError) {
        throw new JobRequestError(
          413,
          'too_large',
          `A chapter may be at most ${this.config.chapterMaxMb} MB`,
        );
      }
      throw err;
    }
    this.jobs.update(id, { lease_expires_at: this.now() + this.jobs.config.leaseSeconds * 1000 });
    return { bytes: size };
  }

  /**
   * Records a chapter whose audio was uploaded: its length and the start/end of each
   * sentence (ms from the chapter's start). A preview or sample is then done; the last
   * chapter of a book starts putting it together.
   */
  async finishChapter(id: number, idx: number, input: CueInput): Promise<WorkerJob> {
    const job = this.held(id);
    const script = await this.readJobScript(id);
    const chapter = script.find((c) => c.index === idx);
    if (!chapter) throw new JobRequestError(400, 'bad_chapter', 'No such chapter');
    const upload = this.file(id, `part-${String(idx).padStart(4, '0')}.upload`);
    const st = await statFile(upload);
    if (!st) throw new JobRequestError(409, 'no_audio', "This chapter's audio was not uploaded");
    const durationMs = Number(input.durationMs);
    const cues = Array.isArray(input.cues) ? (input.cues as unknown[]) : [];
    const valid =
      Number.isFinite(durationMs) &&
      durationMs > 0 &&
      cues.length === chapter.sentences.length &&
      cues.every(
        (c, i) =>
          Array.isArray(c) &&
          c.length === 2 &&
          Number.isFinite(c[0]) &&
          Number.isFinite(c[1]) &&
          (c[0] as number) >= 0 &&
          (c[1] as number) >= (c[0] as number) &&
          (c[1] as number) <= durationMs + 50 &&
          (i === 0 || (c[0] as number) >= ((cues[i - 1] as number[])[1] ?? 0) - 1),
      );
    if (!valid) {
      throw new JobRequestError(400, 'bad_cues', "The chapter's timings don't fit its sentences");
    }
    // The audio itself must be readable and about as long as reported.
    let probe;
    try {
      probe = await probeFile(this.tools.ffprobePath, upload);
    } catch {
      probe = null;
    }
    if (
      !probe?.hasAudio ||
      !(Math.abs(probe.duration * 1000 - durationMs) <= Math.max(500, durationMs * 0.01))
    ) {
      await this.workdir.remove(id, path.basename(upload));
      throw new JobRequestError(
        400,
        'bad_audio',
        "The chapter's audio couldn't be read or has the wrong length",
      );
    }
    const spoken = Array.isArray(input.spoken)
      ? (input.spoken as unknown[]).map((s) =>
          typeof s === 'string' ? s.slice(0, MAX_SPOKEN) : '',
        )
      : null;
    const partName = `part-${String(idx).padStart(4, '0')}.flac`;
    await this.workdir.promote(id, path.basename(upload), partName);
    const now = this.now();
    const counts = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tts_job_chapters (job_id, idx, title, duration_ms, cues, part_file, bytes, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (job_id, idx) DO UPDATE SET duration_ms = excluded.duration_ms,
             cues = excluded.cues, part_file = excluded.part_file, bytes = excluded.bytes,
             done_at = excluded.done_at`,
        )
        .run(
          id,
          idx,
          chapter.title,
          Math.round(durationMs),
          JSON.stringify({
            cues: (cues as number[][]).map(([a, b]) => [Math.round(a), Math.round(b)]),
            spoken,
          }),
          partName,
          st.size,
          now,
        );
      const done = (
        this.db.prepare('SELECT COUNT(*) AS n FROM tts_job_chapters WHERE job_id = ?').get(id) as {
          n: number;
        }
      ).n;
      this.jobs.update(id, {
        chapters_done: done,
        progress: job.chaptersTotal ? Math.min(0.99, done / job.chaptersTotal) : null,
        lease_expires_at: now + this.jobs.config.leaseSeconds * 1000,
      });
      return done;
    })();
    if (job.kind !== 'generate_audiobook') {
      this.jobs.update(id, {
        state: 'done',
        stage: null,
        progress: 1,
        finished_at: this.now(),
        lease_expires_at: null,
      });
      this.log(
        `GPU worker: ${job.kind === 'voice_sample' ? 'voice sample' : 'preview'} ${id} ready`,
      );
      void this.sweep();
    } else if (counts >= (job.chaptersTotal ?? 0)) {
      this.jobs.update(id, { stage: 'assembling', progress: 0.99, message: null });
      this.kickAssembly(id);
    }
    return this.jobs.get(id)!;
  }

  /** What the PC found out about a model on first use. */
  recordCapabilities(input: {
    source?: unknown;
    revision?: unknown;
    description?: unknown;
    clip?: unknown;
  }) {
    if (typeof input.source !== 'string' || typeof input.revision !== 'string') return;
    this.models.recordCapabilities(input.source, input.revision, {
      description: input.description === true,
      clip: input.clip === true,
    });
  }

  // ---------------------------------------------------------------- putting it together

  private kickAssembly(id: number): void {
    if (this.assembling.has(id)) return;
    this.jobs.holdSaving(id, true);
    const run = this.assemble(id)
      .catch((err) => this.logError(`GPU worker: job ${id} could not be finished:`, err))
      .finally(() => {
        this.assembling.delete(id);
        this.jobs.holdSaving(id, false);
        void this.sweep();
      });
    this.assembling.set(id, run);
  }

  /** Waits for the assemblies running now (tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.assembling.values()]);
  }

  private failJob(id: number, message: string): void {
    this.jobs.update(id, {
      state: 'failed',
      error: this.plain(message),
      finished_at: this.now(),
      lease_expires_at: null,
    });
    this.logError(`GPU worker: job ${id} failed: ${this.plain(message)}`);
  }

  private authorOf(bookId: string): string {
    const row = this.db
      .prepare(
        `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
         WHERE ba.book_id = ? ORDER BY ba.position LIMIT 1`,
      )
      .get(bookId) as { name: string } | undefined;
    return row?.name?.trim() || 'Unknown author';
  }

  private async assemble(id: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'running' || !job.bookId || !job.libraryId) return;
    const params = job.params as unknown as VoiceMapV1;
    this.jobs.update(id, { stage: 'assembling', progress: 0.99, lease_expires_at: null });
    const parts = this.doneChapters(id);
    const script = await this.readJobScript(id);
    if (parts.length !== script.length) {
      this.failJob(id, 'Some chapters are missing');
      return;
    }
    const dir = this.jobDir(id);
    const out = this.file(id, 'book.m4b');
    try {
      const totalMs = parts.reduce((n, p) => n + p.duration_ms, 0);
      const title = job.bookTitle ?? 'Audiobook';
      const author = this.authorOf(job.bookId);
      const date = new Date(this.now()).toISOString().slice(0, 10);
      const list = await this.workdir.writeText(
        id,
        'parts.txt',
        buildConcatList(parts.map((p) => path.join(dir, p.part_file))),
      );
      const meta = await this.workdir.writeText(
        id,
        'chapters.txt',
        buildTtsFfmetadata(
          {
            title,
            artist: author,
            album_artist: author,
            album: title,
            genre: 'Audiobook',
            date: date.slice(0, 4),
            comment: `Generated ${date} with ${params.model.label} (${params.model.source}@${params.model.revision.slice(0, 8)}), voice "${params.narrator.name}". Version ${job.version ?? 1}.`,
          },
          parts.map((p) => ({ title: p.title, durationMs: p.duration_ms })),
        ),
      );
      const cover = await this.coverFile(job.userId, job.bookId);
      await this.requireFree(dir, (totalMs / 1000) * 16_000, "the server's cache folder");
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
      args.push('-f', 'concat', '-safe', '0', '-i', list, '-f', 'ffmetadata', '-i', meta);
      if (cover) args.push('-i', cover);
      args.push('-map', '0:a:0');
      if (cover) args.push('-map', '2:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
      args.push('-map_metadata', '1', '-map_chapters', '1');
      args.push(
        '-c:a',
        'aac',
        '-b:a',
        this.config.aacBitrate,
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        out,
      );
      await runTool(this.tools.ffmpegPath, args, {
        timeoutMs: Math.max(30 * 60_000, totalMs * 2),
      });
      const probe = await probeFile(this.tools.ffprobePath, out);
      const expected = totalMs / 1000;
      if (
        !probe.hasAudio ||
        !(Math.abs(probe.duration - expected) <= Math.max(2, expected * 0.005))
      ) {
        throw new Error(
          `The audiobook is ${Math.round(probe.duration)} s long, expected ${Math.round(expected)} s`,
        );
      }
      if (probe.chapters !== parts.length) {
        throw new Error(`The audiobook has ${probe.chapters} chapters, expected ${parts.length}`);
      }
      const srt = buildSrt(
        parts.map((p) => {
          const chapter = script.find((c) => c.index === p.idx)!;
          return {
            durationMs: p.duration_ms,
            cues: (JSON.parse(p.cues) as { cues: [number, number][] }).cues,
            texts: chapter.sentences.map((s) => s.text),
          };
        }),
      );

      // Saving: a new folder for this version, then the two files, through the guarded writer.
      this.jobs.update(id, { stage: 'saving' });
      const outSize = (await fs.stat(out)).size;
      await this.requireFree(this.scan.root, outSize, 'the audiobooks folder');
      const authorPart = safeBaseName(author).slice(0, 120);
      const folderRel = await this.writer.createGeneratedFolder({
        libraryId: job.libraryId,
        area: 'audio',
        parentParts: [authorPart],
        folderNames: versionFolderNames(title, job.version ?? 1),
      });
      const folderName = folderRel.split('/').pop()!;
      const fileBase = safeBaseName(title).slice(0, 180);
      const m4b = await this.writer.createGeneratedFile({
        libraryId: job.libraryId,
        area: 'audio',
        relPath: `${authorPart}/${folderName}/${fileBase}.m4b`,
        source: out,
      });
      this.jobs.update(id, { output_rel_path: m4b.relPath });
      const srtFile = await this.writer.createGeneratedFile({
        libraryId: job.libraryId,
        area: 'audio',
        relPath: `${authorPart}/${folderName}/${fileBase}.srt`,
        source: Buffer.from(srt, 'utf8'),
      });
      const version = /\(v(\d+)\)$/.exec(folderName);
      const folder = await this.scan.rescanGeneratedFolder(job.libraryId, folderRel);
      const linked = folder ? this.autoLink(job, folderRel, m4b.name, srtFile.relPath) : false;
      this.jobs.update(id, {
        state: 'done',
        stage: null,
        progress: 1,
        linked: linked ? 1 : 0,
        version: version ? Number(version[1]) : 1,
        finished_at: this.now(),
        lease_expires_at: null,
      });
      this.log(`GPU worker: audiobook ${id} saved in ${folderRel}${linked ? ' (linked)' : ''}`);
    } catch (err) {
      this.failJob(id, (err as Error).message);
    } finally {
      await this.workdir.remove(id, 'book.m4b');
    }
  }

  private autoLink(job: WorkerJob, folderRel: string, fileName: string, srtRel: string): boolean {
    const queuedWith = (
      this.db.prepare('SELECT link_confirmed_at FROM worker_jobs WHERE id = ?').get(job.id) as {
        link_confirmed_at: number | null;
      }
    ).link_confirmed_at;
    const current = getLink(this.db, job.userId, job.bookId!);
    if ((current?.confirmedAt ?? null) !== queuedWith) return false;
    saveLink(this.db, job.userId, {
      bookId: job.bookId!,
      state: 'linked',
      folderRelPath: folderRel,
      fileName,
      subtitleState: 'linked',
      subtitleRelPath: srtRel,
      source: 'library',
      confirmedAt: this.now(),
    });
    return true;
  }

  private plain(message: string): string {
    return shortenPaths(message, [this.scan.root, this.workdir.root, this.calibreDir]);
  }
}
