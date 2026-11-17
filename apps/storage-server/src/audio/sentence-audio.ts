/**
 * Season 2 Phase 12: Enrich's sentence audio read by the PC, for a book without an
 * audiobook (decided with the user, 2026-11-14/15; decisions.md "AI-generated sentence
 * audio for Enrich").
 *
 * - The device asks for a clip (`queue`) with the Enrich sentence and its reader position;
 *   the server finds the sentence in the book's script (sentence-text.ts, the book's own
 *   furigana kept), applies the pronunciation fixes and queues it on the PC's job queue as
 *   one chapter of a 'sentence_audio' job. Clips of the same book, voice, model and pauses
 *   join the job while it waits, so the PC loads the model once for all of them.
 * - Voice and model: the book's choice, else the one for every book (tts-voice-choice.ts);
 *   none = off (refused, the device then says why).
 * - The queue takes sentence audio first, and a running audiobook makes way after its
 *   chapter (subtitle-jobs.ts).
 * - The PC uploads each clip as FLAC (the WP17 chapter upload); the server cuts it where its
 *   last sentence ends and keeps it as MP3 (AUDIO_CLIP_BITRATE, like a clip of an audiobook)
 *   in CACHE_DIR/tts/<job>/ until the device has it (`drop` after it stored the bytes), at
 *   most TTS_CLIP_KEEP_DAYS.
 * - The device asks how its clip is doing (`status`, with the PC's state for the waiting
 *   text), fetches it when it is done and adds it to the card (the waiting clip, Phase 8).
 *
 * Nothing is written outside CACHE_DIR/tts (TtsWorkdir); ffmpeg writes the MP3 there.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { statFile } from '../calibre/source-fs';
import { getLink } from './audio-links';
import { clipText, type ClipSentence, squeeze } from './sentence-text';
import { JobRequestError, type SubtitleJobService, type WorkerJob } from './subtitle-jobs';
import { encodeMp3 } from './tool-run';
import { parsePauses, type SentenceJobHooks, type TtsJobService } from './tts-jobs';
import { normalizeVoiceMap, type VoiceMapV2 } from './voice-map';
import type { ScriptChapter } from './book-script';
import type { VoiceChoiceService } from './tts-voice-choice';

export type ClipState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SentenceClipView {
  id: string;
  bookId: string;
  state: ClipState;
  /** Length of the finished clip (ms). */
  durationMs: number | null;
  /** The MP3's size (bytes). */
  bytes: number | null;
  error: string | null;
  /** Whether the text was found in the book (false: read without the book's furigana). */
  found: boolean;
  createdAt: number;
  doneAt: number | null;
}

/** The PC as the device's waiting text needs it. */
export interface PcView {
  online: boolean;
  lastSeenAt: number | null;
  paused: boolean;
  problem: string | null;
  /** Whether the PC's program reads sentence audio (null: it hasn't asked for work yet). */
  readsClips: boolean | null;
  /** Another job the PC is working on now, if any. */
  ahead: { kind: WorkerJob['kind']; bookTitle: string | null; makesWay: boolean } | null;
}

interface ClipRow {
  id: string;
  user_id: string;
  book_id: string;
  job_id: number | null;
  idx: number | null;
  text: string;
  sentences: string;
  found: number;
  fixes: string | null;
  state: 'waiting' | 'done' | 'failed' | 'cancelled';
  duration_ms: number | null;
  bytes: number | null;
  error: string | null;
  created_at: number;
  done_at: number | null;
  picked_up_at: number | null;
}

export interface SentenceAudioOptions {
  db: Database.Database;
  jobs: SubtitleJobService;
  tts: TtsJobService;
  choices: VoiceChoiceService;
  /** MP3 bitrate of a clip (AUDIO_CLIP_BITRATE). */
  bitrate: string;
  now?: () => number;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const clipFile = (id: string) => `clip-${id}.mp3`;

export class SentenceAudioService implements SentenceJobHooks {
  private readonly db: Database.Database;
  private readonly jobs: SubtitleJobService;
  private readonly tts: TtsJobService;
  private readonly choices: VoiceChoiceService;
  private readonly bitrate: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;

  constructor(opts: SentenceAudioOptions) {
    this.db = opts.db;
    this.jobs = opts.jobs;
    this.tts = opts.tts;
    this.choices = opts.choices;
    this.bitrate = opts.bitrate;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.tts.attachSentenceAudio(this);
  }

  private get keepMs(): number {
    return this.tts.config.clipKeepDays * 86_400_000;
  }

  private row(id: string): ClipRow | null {
    return (
      (this.db.prepare('SELECT * FROM tts_sentence_clips WHERE id = ?').get(id) as
        | ClipRow
        | undefined) ?? null
    );
  }

  // ---------------------------------------------------------------- the device

  /** Queues a clip for the PC (202), or refuses with the reason. */
  async queue(
    userId: string,
    bookId: string,
    input: { text?: unknown; position?: unknown; pauses?: unknown },
  ): Promise<SentenceClipView> {
    const text = typeof input.text === 'string' ? input.text : '';
    const length = [...squeeze(text)].length;
    if (length === 0) throw new JobRequestError(400, 'no_text', 'No sentence to read');
    const max = this.tts.config.clipMaxCharacters;
    if (length > max) {
      throw new JobRequestError(400, 'too_long', `the sentence is longer than ${max} characters`);
    }
    const position =
      typeof input.position === 'number' && Number.isFinite(input.position) && input.position >= 0
        ? Math.round(input.position)
        : 0;
    const link = getLink(this.db, userId, bookId);
    if (link?.state === 'linked') {
      throw new JobRequestError(
        409,
        'has_audiobook',
        'The book has an audiobook: its sentence audio comes from it',
      );
    }
    const choice = this.choices.resolve(userId, bookId);
    if (!choice) {
      throw new JobRequestError(
        409,
        'voice_choice_off',
        'Sentence audio from the PC is off: choose a voice in Settings > Anki',
      );
    }
    const script = await this.tts.bookScript(userId, bookId);
    const found = clipText(
      script.chapters.flatMap((c) => c.sentences),
      text,
      position,
    );
    const fixed = await this.tts.applyFixes(userId, bookId, [
      { index: 0, title: '', startCharacter: 0, characters: 0, sentences: found.sentences },
    ]);
    const sentences = fixed.chapters[0].sentences as ClipSentence[];
    const pauses = { ...parsePauses(input.pauses), chapterMs: 0 };
    const params = this.tts.voiceMap(choice.voice, choice.model, bookId, pauses, choice.dialogue);
    // Session 5: every voiced character of the book is in a clip's map (not only the ones
    // this clip needs), so the book's clips still share one job.
    this.tts.speakers?.extend(userId, bookId, params);
    this.tts.speakers?.assign(userId, bookId, sentences, params, { prune: false });
    const key = joinKey(params);
    const id = randomUUID().replace(/-/g, '');
    const now = this.now();
    const jobId = this.db.transaction((): number => {
      const waiting = this.db
        .prepare(
          `SELECT id, params, chapters_total FROM worker_jobs WHERE user_id = ? AND book_id = ?
             AND kind = 'sentence_audio' AND state = 'queued' ORDER BY id`,
        )
        .all(userId, bookId) as { id: number; params: string | null; chapters_total: number }[];
      const join = waiting.find((j) => {
        try {
          return joinKey(normalizeVoiceMap(JSON.parse(j.params ?? 'null'))) === key;
        } catch {
          return false;
        }
      });
      let job: number;
      let idx: number;
      if (join) {
        job = join.id;
        idx = join.chapters_total;
        this.jobs.update(job, { chapters_total: idx + 1 });
      } else {
        job = this.tts.insertJob({
          userId,
          bookId,
          kind: 'sentence_audio',
          libraryId: this.tts.bookLibrary(bookId),
          linkConfirmedAt: null,
          params,
          version: null,
          chaptersTotal: 1,
        });
        idx = 0;
      }
      this.db
        .prepare(
          `INSERT INTO tts_sentence_clips (id, user_id, book_id, job_id, idx, text, sentences, found,
             fixes, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
        )
        .run(
          id,
          userId,
          bookId,
          job,
          idx,
          text,
          JSON.stringify(sentences),
          found.found ? 1 : 0,
          fixed.summary ? JSON.stringify(fixed.summary) : null,
          now,
        );
      return job;
    })();
    this.log(
      `GPU worker: sentence audio queued for book ${bookId} (job ${jobId}${found.found ? '' : ', text not found in the book'})`,
    );
    return this.view(this.row(id)!);
  }

  /** The clip and the PC's state, or null when there is no such clip (or it is gone). */
  status(userId: string, id: string): { clip: SentenceClipView; pc: PcView } | null {
    const row = this.row(id);
    if (!row || row.user_id !== userId || this.gone(row)) return null;
    return { clip: this.view(row), pc: this.pc(row.job_id) };
  }

  /** The finished MP3, or null. */
  async audioFile(userId: string, id: string): Promise<string | null> {
    const row = this.row(id);
    if (!row || row.user_id !== userId || row.state !== 'done' || this.gone(row)) return null;
    if (row.job_id === null) return null;
    const file = this.tts.workdir.file(row.job_id, clipFile(row.id));
    return (await statFile(file)) ? file : null;
  }

  /**
   * The device has the clip, or no longer wants it: a finished one is deleted, a waiting
   * one is taken out of its job (or left out when the PC reads it already).
   */
  async drop(userId: string, id: string): Promise<boolean> {
    const row = this.row(id);
    if (!row || row.user_id !== userId) return false;
    const now = this.now();
    if (row.state === 'done') {
      this.db.prepare('UPDATE tts_sentence_clips SET picked_up_at = ? WHERE id = ?').run(now, id);
      if (row.job_id !== null) await this.tts.workdir.remove(row.job_id, clipFile(id));
      return true;
    }
    if (row.state !== 'waiting') return true;
    let emptied: number | null = null;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE tts_sentence_clips SET state = 'cancelled', done_at = ? WHERE id = ?")
        .run(now, id);
      const job = row.job_id !== null ? this.jobs.get(row.job_id) : null;
      // A job the PC already read part of (it went back to the queue) keeps its numbering:
      // the clip is read and then thrown away, like one cancelled while the PC reads it.
      if (!job || job.state !== 'queued' || row.idx === null || job.chaptersDone > 0) return;
      // Still waiting: the job reads the others only.
      this.db.prepare('UPDATE tts_sentence_clips SET idx = NULL WHERE id = ?').run(id);
      this.db
        .prepare('UPDATE tts_sentence_clips SET idx = idx - 1 WHERE job_id = ? AND idx > ?')
        .run(job.id, row.idx);
      const left = (job.chaptersTotal ?? 1) - 1;
      this.jobs.update(job.id, { chapters_total: left });
      if (left <= 0) emptied = job.id;
    })();
    if (emptied !== null) this.jobs.cancel(userId, emptied);
    return true;
  }

  // ---------------------------------------------------------------- the PC's job

  /** The clips of a job as its chapters (index = the clip's place in the job). */
  script(jobId: number): ScriptChapter[] {
    const rows = this.db
      .prepare(
        'SELECT id, idx, sentences FROM tts_sentence_clips WHERE job_id = ? AND idx IS NOT NULL ORDER BY idx',
      )
      .all(jobId) as { id: string; idx: number; sentences: string }[];
    return rows.map((r) => ({
      index: r.idx,
      title: `Sentence ${r.id.slice(0, 8)}`,
      startCharacter: 0,
      characters: 0,
      sentences: JSON.parse(r.sentences) as ClipSentence[],
    }));
  }

  /** A clip the PC read: cut where its last sentence ends and kept as MP3. */
  async clipRead(job: WorkerJob, idx: number, partName: string, cues: number[][]): Promise<void> {
    const row = this.db
      .prepare('SELECT * FROM tts_sentence_clips WHERE job_id = ? AND idx = ?')
      .get(job.id, idx) as ClipRow | undefined;
    const workdir = this.tts.workdir;
    if (!row || row.state !== 'waiting') {
      await workdir.remove(job.id, partName);
      return;
    }
    const endMs = Math.max(1, Math.round(cues[cues.length - 1]?.[1] ?? 0));
    const out = workdir.file(job.id, clipFile(row.id));
    const now = this.now();
    try {
      await encodeMp3(
        this.tts.toolPaths.ffmpegPath,
        workdir.file(job.id, partName),
        out,
        this.bitrate,
        { endMs },
      );
      const st = await statFile(out);
      if (!st) throw new Error('ffmpeg wrote no file');
      this.db
        .prepare(
          `UPDATE tts_sentence_clips SET state = 'done', duration_ms = ?, bytes = ?, done_at = ?
             WHERE id = ? AND state = 'waiting'`,
        )
        .run(endMs, st.size, now, row.id);
    } catch (err) {
      const message = `the clip couldn't be made: ${(err as Error).message}`;
      this.db
        .prepare(
          "UPDATE tts_sentence_clips SET state = 'failed', error = ?, done_at = ? WHERE id = ?",
        )
        .run(message.slice(0, 500), now, row.id);
      this.logError(`GPU worker: sentence clip ${row.id} (job ${job.id}): ${message}`);
    } finally {
      await workdir.remove(job.id, partName);
    }
  }

  /** Work folders to keep: waiting and running jobs, and clips no device has fetched yet. */
  keepJobs(): Set<number> {
    const keep = new Set<number>();
    const rows = this.db
      .prepare(
        `SELECT id AS job_id FROM worker_jobs WHERE kind = 'sentence_audio' AND state IN ('queued', 'running')
         UNION
         SELECT job_id FROM tts_sentence_clips WHERE state = 'done' AND picked_up_at IS NULL
           AND job_id IS NOT NULL AND done_at >= ?`,
      )
      .all(this.now() - this.keepMs) as { job_id: number }[];
    for (const r of rows) keep.add(r.job_id);
    return keep;
  }

  // ---------------------------------------------------------------- views

  /** Fetched already, or kept past TTS_CLIP_KEEP_DAYS. */
  private gone(row: ClipRow): boolean {
    if (row.picked_up_at !== null) return true;
    return row.state === 'done' && (row.done_at ?? 0) < this.now() - this.keepMs;
  }

  private view(row: ClipRow): SentenceClipView {
    let state: ClipState;
    let error = row.error;
    if (row.state !== 'waiting') {
      state = row.state;
    } else {
      const job = row.job_id !== null ? this.jobs.get(row.job_id) : null;
      if (!job) {
        state = 'failed';
        error = 'its job on the PC is gone';
      } else if (job.state === 'queued' || job.state === 'running') {
        state = job.state;
      } else if (job.state === 'failed') {
        state = 'failed';
        error = job.error ?? 'the PC could not read it';
      } else if (job.state === 'cancelled') {
        state = 'failed';
        error = 'it was stopped in Settings > Audiobooks';
      } else {
        state = 'failed';
        error = 'the PC did not read it';
      }
    }
    return {
      id: row.id,
      bookId: row.book_id,
      state,
      durationMs: row.duration_ms,
      bytes: row.bytes,
      error,
      found: row.found === 1,
      createdAt: row.created_at,
      doneAt: row.done_at,
    };
  }

  private pc(jobId: number | null): PcView {
    const s = this.db.prepare('SELECT * FROM worker_status WHERE id = 1').get() as
      | { paused: number; last_seen_at: number | null; problem: string | null }
      | undefined;
    const offlineMs = this.jobs.config.offlineSeconds * 1000;
    const running = this.db
      .prepare(
        `SELECT j.id, j.kind, b.title FROM worker_jobs j LEFT JOIN books b ON b.id = j.book_id
         WHERE j.state = 'running' LIMIT 1`,
      )
      .get() as { id: number; kind: WorkerJob['kind']; title: string | null } | undefined;
    const readsClips = this.jobs.readsSentenceAudio();
    return {
      online: !!s?.last_seen_at && this.now() - s.last_seen_at <= offlineMs,
      lastSeenAt: s?.last_seen_at ?? null,
      paused: s?.paused === 1,
      problem: s?.problem ?? null,
      readsClips,
      ahead:
        running && running.id !== jobId
          ? {
              kind: running.kind,
              bookTitle: running.title,
              makesWay: running.kind === 'generate_audiobook' && readsClips === true,
            }
          : null,
    };
  }
}

/** Clips join a waiting job only with the same voices (and their clips), model and pauses. */
function joinKey(p: VoiceMapV2 | null): string {
  if (!p) return '';
  const voice = (key: string) => [p.voices[key]?.voiceId ?? null, p.voices[key]?.sha256 ?? null];
  return JSON.stringify([
    ...voice(p.roles.narration),
    ...(p.roles.dialogue === p.roles.narration ? [] : voice(p.roles.dialogue)),
    p.model.id,
    p.model.revision,
    p.pauses.sentenceMs,
    p.pauses.paragraphMs,
    p.pauses.chapterMs,
    ...(p.roles.dialogue === p.roles.narration ? [] : [p.pauses.dialogueMs]),
    // Session 5: the character voices (and who reads the narration).
    ...Object.keys(p.voices)
      .filter((k) => k.startsWith('character:'))
      .sort()
      .map((k) => `${k}=${p.voices[k].sha256}`),
    p.roles.narration,
  ]);
}

/** For tests: the file name of a clip's MP3 in its job's work folder. */
export const sentenceClipFile = (jobId: number, id: string, root: string) =>
  path.join(root, String(jobId), clipFile(id));
