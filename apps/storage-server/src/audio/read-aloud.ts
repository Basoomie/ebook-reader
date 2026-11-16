/**
 * Season 2 Phase 12 session 3: live read-aloud with the PC's voice (decided with the user,
 * 2026-11-14/16; decisions.md "Live read-aloud with the PC's voice").
 *
 * The device builds the book's sentences itself, from its own copy, with the reader's own
 * code (book-script.ts: text, reading with the book's furigana, furigana runs, reader
 * position), so they match its screen exactly; this works for books outside the library
 * too. It sends them in small batches ahead of what it plays:
 *
 *   device ── batch ─▶ server: pronunciation fixes (book list + global) ─▶ waiting batch
 *   PC (worker 1.2.0+) ── /worker/live/next (held open) ─▶ its loaded voice process ─▶ FLAC
 *   PC ── FLAC + timings ─▶ server: MP3 (AUDIO_CLIP_BITRATE) in CACHE_DIR/tts-live/<session>/
 *   device ── session state (held open) / batch MP3 ─▶ one audio element (Media Source)
 *
 * - The phone can't reach the PC itself (not on the tailnet; an HTTPS page can't call
 *   plain http), so everything goes through here, like the worker's other traffic.
 * - One session at a time: a session from another device takes over (the first device is
 *   told). Sessions live in memory: a server restart ends them (the device starts again).
 * - A session needs the PC while it plays or has batches waiting ("live"): the queue hands
 *   out nothing and a running audiobook makes way at once (subtitle-jobs.ts). Paused or
 *   stopped, the voice stays loaded for the keep time (Settings > Audiobooks), counted from
 *   the last use.
 * - Voice and model: the book's PC voice, else the one for every book (Settings > Anki), as
 *   for Enrich's clips; the seed is the book's (seedFor), so it sounds like the book's
 *   preview and clips.
 * - A session whose device stops asking for READ_ALOUD_DEVICE_IDLE_SECONDS ends; a batch the
 *   PC took and didn't finish within the worker lease goes back to waiting.
 *
 * Nothing is written outside CACHE_DIR/tts-live (ReadAloudWorkdir); ffmpeg writes the MP3s
 * there.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { statFile } from '../calibre/source-fs';
import type { TtsConfig } from '../config';
import type { VoiceService } from '../voices/voice-service';
import type { RubyRun } from '../pronunciation/fix-rules';
import type { ScriptChapter } from './book-script';
import { ReadAloudWorkdir } from './read-aloud-workdir';
import {
  JobRequestError,
  type EngineState,
  type ReadAloudGate,
  type SubtitleJobService,
  type WorkerJobKind,
  versionAtLeast,
} from './subtitle-jobs';
import { encodeMp3, probeFile } from './tool-run';
import {
  parsePauses,
  type Pauses,
  seedFor,
  type TtsJobService,
  VOICES_WORKER_VERSION,
} from './tts-jobs';
import {
  type DialoguePart,
  dialogueVoice,
  type ScriptSegment,
  usesSeveralVoices,
  type VoiceMapV2,
  type WorkerSegment,
  workerSegments,
  workerVoices,
} from './voice-map';
import type { VoiceChoiceService } from './tts-voice-choice';

/** Most sentences in one batch, and batches waiting for the PC at once. */
export const MAX_BATCH_SENTENCES = 32;
export const MAX_WAITING_BATCHES = 4;
const MAX_TEXT = 500;
const MAX_READING = 2000;
/** Largest batch upload (bytes): 32 sentences of FLAC are far below this. */
const MAX_BATCH_BYTES = 200 * 1024 * 1024;

export type BatchState = 'waiting' | 'reading' | 'done' | 'failed';
export type SessionEnd = 'stopped' | 'takeover' | 'idle' | 'server';

/** A sentence as the device sends it (book-script.ts ScriptSentence). */
export interface ReadAloudSentence {
  text: string;
  reading: string;
  ruby: RubyRun[];
  position: number;
  paragraphEnd: boolean;
  /** Session 4: the sentence's dialogue runs (book-script.ts v3). */
  parts?: DialoguePart[];
  /** Set by the server (applyFixes): the runs with their readings. */
  segments?: ScriptSegment[];
}

interface Batch {
  seq: number;
  sentences: ReadAloudSentence[];
  state: BatchState;
  takenAt: number | null;
  durationMs: number | null;
  /** [start, end] ms of each sentence in the batch's audio. */
  cues: number[][] | null;
  bytes: number | null;
  error: string | null;
  fetched: boolean;
}

interface Session {
  id: string;
  userId: string;
  bookId: string | null;
  voice: { id: string; name: string; sha256: string; clipRelative: string };
  model: { id: number; source: string; revision: string; label: string };
  from: 'book' | 'global';
  seed: number;
  /** Session 4: the voices (narration, dialogue) as a job's voice map, and their clips. */
  map: VoiceMapV2;
  clips: Map<string, string>;
  pauses: Pauses;
  createdAt: number;
  lastPollAt: number;
  playing: boolean;
  nextSeq: number;
  batches: Map<number, Batch>;
}

/** What the device sees of a batch. */
export interface BatchView {
  seq: number;
  state: BatchState;
  durationMs: number | null;
  cues: number[][] | null;
  error: string | null;
}

/** The PC as read-aloud's status line needs it. */
export interface LivePcView {
  online: boolean;
  lastSeenAt: number | null;
  paused: boolean;
  problem: string | null;
  version: string | null;
  /** The PC's program can read aloud (1.2.0+). */
  supportsLive: boolean;
  /** The PC asked for read-aloud work recently (or is loading the voice for it). */
  answering: boolean;
  /** The last time the PC asked for read-aloud work. */
  lastAskedAt: number | null;
  engine: EngineState | null;
  /** A job the PC is busy with: one that makes way (yielding), or a subtitle job it finishes. */
  busy: { kind: WorkerJobKind; bookTitle: string | null; yielding: boolean } | null;
}

export interface SessionView {
  id: string;
  bookId: string | null;
  state: 'open' | 'ended';
  ended: SessionEnd | null;
  /** `dialogue`: the dialogue voice's name when it has its own (session 4). */
  voice: { name: string; dialogue: string | null; model: string; from: 'book' | 'global' };
  /** The batches after `after`, in order. */
  batches: BatchView[];
  pc: LivePcView;
}

/** What the PC gets from /worker/live/next. */
export interface LiveAssignment {
  session: {
    id: string;
    model: { source: string; revision: string };
    voice: { sha256: string };
    seed: number;
    /** Session 4 (worker 1.3.0+): every voice by key; segments name these keys. */
    voices: Record<string, { sha256: string; seed: number }>;
    pauses: Pauses;
  };
  batch: {
    seq: number;
    sentences: {
      text: string;
      reading: string;
      paragraphEnd: boolean;
      segments?: WorkerSegment[];
    }[];
  } | null;
}

export interface ReadAloudOptions {
  db: Database.Database;
  jobs: SubtitleJobService;
  tts: TtsJobService;
  choices: VoiceChoiceService;
  voices: VoiceService;
  config: TtsConfig;
  /** MP3 bitrate (AUDIO_CLIP_BITRATE). */
  bitrate: string;
  cacheDir: string;
  audiobooksRoot: string;
  /** Can the user see this book (a library book id)? */
  bookExists: (userId: string, bookId: string) => boolean;
  now?: () => number;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const batchFile = (seq: number, ext: 'flac' | 'mp3') => `b-${seq}.${ext}`;
/** A held device request looks again this often (ms). */
const RECHECK_MS = 2000;

export class ReadAloudService implements ReadAloudGate {
  readonly workdir: ReadAloudWorkdir;
  private readonly db: Database.Database;
  private readonly jobs: SubtitleJobService;
  private readonly tts: TtsJobService;
  private readonly choices: VoiceChoiceService;
  private readonly voices: VoiceService;
  private readonly config: TtsConfig;
  private readonly bitrate: string;
  private readonly bookExists: (userId: string, bookId: string) => boolean;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private session: Session | null = null;
  /** Sessions that ended recently, so their device learns why (id → why). */
  private readonly endedWhy = new Map<string, { why: SessionEnd; at: number }>();
  /** Long-polls waiting for a change (devices and the PC). */
  private readonly waiters = new Set<() => void>();
  private pcAskedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: ReadAloudOptions) {
    this.db = opts.db;
    this.jobs = opts.jobs;
    this.tts = opts.tts;
    this.choices = opts.choices;
    this.voices = opts.voices;
    this.config = opts.config;
    this.bitrate = opts.bitrate;
    this.bookExists = opts.bookExists;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.workdir = new ReadAloudWorkdir(opts.cacheDir, opts.audiobooksRoot);
    this.jobs.attachReadAloud(this);
  }

  async start(): Promise<void> {
    await this.workdir.clear();
    this.timer = setInterval(() => this.housekeep(), 5000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.session) await this.end(this.session, 'server');
  }

  // ---------------------------------------------------------------- the queue's view

  /** Whether the PC's program can read this session (its voices). */
  private pcReadsSession(s: Session): boolean {
    return (
      !usesSeveralVoices(s.map) || versionAtLeast(this.jobs.workerVersion(), VOICES_WORKER_VERSION)
    );
  }

  /** A session needs the PC now: it plays, or batches wait for the PC (ReadAloudGate). */
  needsPc(): boolean {
    const s = this.session;
    if (!s) return false;
    // Session 4: two voices need worker 1.3.0; an older PC isn't asked (the device says so).
    if (!this.pcReadsSession(s)) return false;
    if (s.playing) return true;
    for (const b of s.batches.values()) {
      if (b.state === 'waiting' || b.state === 'reading') return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the device

  /** Starts read-aloud for a book (null: a book outside the library); takes over any other. */
  async open(userId: string, input: { bookId?: unknown; pauses?: unknown }): Promise<SessionView> {
    const bookId = typeof input.bookId === 'string' && input.bookId !== '' ? input.bookId : null;
    if (bookId !== null && !this.bookExists(userId, bookId)) {
      throw new JobRequestError(404, 'not_found', 'No such book');
    }
    const choice = bookId
      ? this.choices.resolve(userId, bookId)
      : this.choices.resolveGlobal(userId);
    if (!choice) {
      throw new JobRequestError(
        409,
        'voice_choice_off',
        bookId
          ? 'No PC voice is chosen: choose one for this book, or in Settings > Anki'
          : 'No PC voice is chosen: choose one in Settings > Anki',
      );
    }
    const from = bookId
      ? (this.choices.forBook(userId, bookId).effective?.from ?? 'global')
      : 'global';
    if (this.session) await this.end(this.session, 'takeover');
    const now = this.now();
    const pauses = { ...parsePauses(input.pauses), chapterMs: 0 };
    const map = this.tts.voiceMap(
      choice.voice,
      choice.model,
      bookId ?? 'read-aloud',
      pauses,
      choice.dialogue,
    );
    const clips = new Map([[choice.voice.sha256, this.voices.clipRelative(choice.voice.id)]]);
    if (choice.dialogue) {
      clips.set(choice.dialogue.sha256, this.voices.clipRelative(choice.dialogue.id));
    }
    const session: Session = {
      id: randomUUID().replace(/-/g, ''),
      userId,
      bookId,
      voice: {
        id: choice.voice.id,
        name: choice.voice.name,
        sha256: choice.voice.sha256,
        clipRelative: this.voices.clipRelative(choice.voice.id),
      },
      model: {
        id: choice.model.id,
        source: choice.model.source,
        revision: choice.model.revision,
        label: choice.model.label,
      },
      from,
      seed: seedFor(bookId ?? 'read-aloud', choice.voice.sha256),
      map,
      clips,
      pauses,
      createdAt: now,
      lastPollAt: now,
      playing: false,
      nextSeq: 1,
      batches: new Map(),
    };
    this.session = session;
    this.log(
      `Read-aloud: started for ${bookId ? `book ${bookId}` : 'a book outside the library'} (${session.voice.name}, ${session.model.label})`,
    );
    this.changed();
    return this.view(session, 0);
  }

  /** The device's session, or why it ended (410), or 404. */
  private own(userId: string, id: string): Session {
    const s = this.session;
    if (s && s.id === id && s.userId === userId) return s;
    const ended = this.endedWhy.get(id);
    if (ended) {
      throw new JobRequestError(410, 'ended', 'This read-aloud session has ended', {
        why: ended.why,
      });
    }
    throw new JobRequestError(404, 'not_found', 'No such read-aloud session');
  }

  /**
   * Sentences to read next. `replace`: the waiting batches are dropped first (the device
   * skipped beyond what it has). Returns the batch number.
   */
  async addBatch(
    userId: string,
    id: string,
    input: { sentences?: unknown; replace?: unknown },
  ): Promise<{ seq: number }> {
    const s = this.own(userId, id);
    const sentences = parseSentences(input.sentences);
    const fixed = await this.tts.applyFixes(userId, s.bookId, [
      { index: 0, title: '', startCharacter: 0, characters: 0, sentences } as ScriptChapter,
    ]);
    // The session may have ended while the fixes ran.
    if (this.session !== s) this.own(userId, id);
    if (input.replace === true) {
      for (const [seq, b] of s.batches) if (b.state === 'waiting') s.batches.delete(seq);
    }
    const waiting = [...s.batches.values()].filter((b) => b.state === 'waiting').length;
    if (waiting >= MAX_WAITING_BATCHES) {
      throw new JobRequestError(429, 'too_many', 'Too many batches are waiting for the PC');
    }
    const seq = s.nextSeq++;
    s.batches.set(seq, {
      seq,
      sentences: fixed.chapters[0].sentences as ReadAloudSentence[],
      state: 'waiting',
      takenAt: null,
      durationMs: null,
      cues: null,
      bytes: null,
      error: null,
      fetched: false,
    });
    s.playing = true;
    s.lastPollAt = this.now();
    this.jobs.touchVoice();
    this.changed();
    this.jobs.notify();
    return { seq };
  }

  /**
   * The session as it is now, held open up to `wait` seconds until something changes.
   * `after`: the device has every batch up to this one (their files are let go).
   * `playing`: whether the device plays (or wants to); paused, the keep time runs.
   */
  async poll(
    userId: string,
    id: string,
    { after, wait, playing }: { after: number; wait: number; playing: boolean | null },
    isClosed: () => boolean = () => false,
  ): Promise<SessionView> {
    let s = this.own(userId, id);
    s.lastPollAt = this.now();
    if (playing !== null && playing !== s.playing) {
      s.playing = playing;
      this.jobs.touchVoice();
      // The PC's held request hears it at once (paused: it goes back to its queue).
      this.changed();
      this.jobs.notify();
    } else if (s.playing) {
      this.jobs.touchVoice();
    }
    await this.forget(s, after);
    const before = JSON.stringify(this.view(s, after));
    // Waiting is real time (the clock may be a test's).
    const until = Date.now() + Math.min(wait, this.config.readAloudPollWaitSeconds) * 1000;
    while (!isClosed() && Date.now() < until) {
      // Woken by a change, and every 2 s: the PC's state also changes by time (it stopped
      // asking, it went offline), which nothing announces.
      await this.waitForChange(Math.min(until - Date.now(), RECHECK_MS));
      s = this.own(userId, id);
      s.lastPollAt = this.now();
      if (JSON.stringify(this.view(s, after)) !== before) break;
    }
    return this.view(this.own(userId, id), after);
  }

  /** A batch's MP3, or null when it isn't ready. */
  async audioFile(userId: string, id: string, seq: number): Promise<string | null> {
    const s = this.own(userId, id);
    const b = s.batches.get(seq);
    if (!b || b.state !== 'done') return null;
    const file = this.workdir.file(s.id, batchFile(seq, 'mp3'));
    if (!(await statFile(file))) return null;
    b.fetched = true;
    return file;
  }

  /** Stop: the session ends (the voice stays loaded for the keep time). */
  async close(userId: string, id: string): Promise<void> {
    const s = this.session;
    if (!s || s.id !== id || s.userId !== userId) return;
    await this.end(s, 'stopped');
  }

  // ---------------------------------------------------------------- the PC

  /**
   * The PC asks for read-aloud work (held open up to `wait` s when `take`). `take` false:
   * only the session's settings (the PC loads the voice first). Null: no session needs the
   * PC (it goes back to its queue, keeping the voice loaded for the keep time).
   */
  async next(
    input: { engine?: unknown; take?: unknown; wait?: unknown },
    isClosed: () => boolean = () => false,
  ): Promise<LiveAssignment | null> {
    // The device shows "loading the voice" (and when it is loaded) at once.
    if (this.jobs.recordEngine(input.engine)) this.changed();
    const take = input.take !== false;
    const wait =
      typeof input.wait === 'number' && Number.isFinite(input.wait)
        ? Math.min(Math.max(0, input.wait), this.config.readAloudPollWaitSeconds)
        : 0;
    const until = Date.now() + wait * 1000;
    for (;;) {
      this.seen();
      const s = this.session;
      if (!s || !this.jobs.live()) return null;
      if (take) {
        const batch = [...s.batches.values()].find((b) => b.state === 'waiting');
        if (batch) {
          batch.state = 'reading';
          batch.takenAt = this.now();
          this.changed();
          return this.assignment(s, batch);
        }
      }
      if (!take || isClosed() || Date.now() >= until) return this.assignment(s, null);
      await this.waitForChange(until - Date.now());
    }
  }

  /** The voice clip of the current session (path inside the voice store). */
  voiceClip(sha256: string): { relative: string } {
    const relative = this.session?.clips.get(sha256);
    if (!relative) {
      throw new JobRequestError(404, 'not_found', 'No read-aloud session uses this voice');
    }
    return { relative };
  }

  private heldBatch(sessionId: string, seq: number): { s: Session; b: Batch } {
    const s = this.session;
    if (!s || s.id !== sessionId) {
      throw new JobRequestError(409, 'ended', 'This read-aloud session has ended');
    }
    const b = s.batches.get(seq);
    if (!b || b.state !== 'reading') {
      throw new JobRequestError(409, 'not_reading', 'This batch is not being read');
    }
    return { s, b };
  }

  /** The PC's FLAC of a batch. */
  async receive(sessionId: string, seq: number, body: NodeJS.ReadableStream): Promise<number> {
    const { s } = this.heldBatch(sessionId, seq);
    this.seen();
    return this.workdir.receive(s.id, batchFile(seq, 'flac'), body, MAX_BATCH_BYTES);
  }

  /** The PC read a batch: its timings are checked and its MP3 made for the device. */
  async finish(sessionId: string, seq: number, input: { durationMs?: unknown; cues?: unknown }) {
    const { s, b } = this.heldBatch(sessionId, seq);
    this.seen();
    const flac = this.workdir.file(s.id, batchFile(seq, 'flac'));
    const cues = parseCues(input.cues, b.sentences.length);
    const durationMs =
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? Math.round(input.durationMs)
        : null;
    if (!cues || durationMs === null || cues[cues.length - 1][1] > durationMs + 1) {
      throw new JobRequestError(400, 'invalid_body', 'The timings do not fit the sentences');
    }
    if (!(await statFile(flac))) {
      throw new JobRequestError(409, 'no_audio', 'The batch audio was not uploaded');
    }
    const probe = await probeFile(this.tts.toolPaths.ffprobePath, flac).catch(() => null);
    if (
      !probe?.hasAudio ||
      Math.abs(probe.duration * 1000 - durationMs) > Math.max(500, durationMs * 0.01)
    ) {
      await this.workdir.remove(s.id, batchFile(seq, 'flac'));
      throw new JobRequestError(400, 'invalid_audio', 'The batch audio does not match its length');
    }
    const mp3 = this.workdir.file(s.id, batchFile(seq, 'mp3'));
    try {
      await encodeMp3(this.tts.toolPaths.ffmpegPath, flac, mp3, this.bitrate);
      const st = await statFile(mp3);
      if (!st) throw new Error('ffmpeg wrote no file');
      if (this.session !== s) return { state: 'ended' };
      Object.assign(b, { state: 'done', durationMs, cues, bytes: st.size, error: null });
    } catch (err) {
      Object.assign(b, {
        state: 'failed',
        error: `the audio couldn't be made: ${(err as Error).message}`,
      });
      this.logError(`Read-aloud: batch ${seq}: ${b.error}`);
    } finally {
      await this.workdir.remove(s.id, batchFile(seq, 'flac'));
    }
    this.jobs.touchVoice();
    this.changed();
    return { state: b.state };
  }

  /** The PC couldn't read a batch (the device shows why). */
  fail(sessionId: string, seq: number, input: { error?: unknown }): void {
    const { b } = this.heldBatch(sessionId, seq);
    this.seen();
    b.state = 'failed';
    b.error =
      typeof input.error === 'string' && input.error.trim()
        ? input.error.trim().slice(0, 500)
        : 'the PC could not read it';
    this.logError(`Read-aloud: the PC could not read batch ${seq}: ${b.error}`);
    this.changed();
  }

  // ---------------------------------------------------------------- inside

  private assignment(s: Session, b: Batch | null): LiveAssignment {
    return {
      session: {
        id: s.id,
        model: { source: s.model.source, revision: s.model.revision },
        voice: { sha256: s.voice.sha256 },
        seed: s.seed,
        voices: workerVoices(s.map),
        pauses: s.pauses,
      },
      batch: b
        ? {
            seq: b.seq,
            sentences: b.sentences.map((x) => {
              const segments = workerSegments(x.segments, s.map);
              return {
                text: x.text,
                reading: x.reading,
                paragraphEnd: x.paragraphEnd,
                ...(segments ? { segments } : {}),
              };
            }),
          }
        : null,
    };
  }

  /** The PC asked for read-aloud work now (it counts as seen, like its reports). */
  private seen(): void {
    this.pcAskedAt = this.now();
    this.db.prepare('UPDATE worker_status SET last_seen_at = ? WHERE id = 1').run(this.pcAskedAt);
  }

  private changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
    });
  }

  /** Batches the device has (up to `after`, fetched): their files are let go. */
  private async forget(s: Session, after: number): Promise<void> {
    for (const [seq, b] of s.batches) {
      if (seq > after) continue;
      if (b.state === 'done' && !b.fetched) continue;
      if (b.state === 'waiting' || b.state === 'reading') continue;
      s.batches.delete(seq);
      await this.workdir.remove(s.id, batchFile(seq, 'mp3'));
    }
  }

  private async end(s: Session, why: SessionEnd): Promise<void> {
    if (this.session !== s) return;
    this.session = null;
    this.endedWhy.set(s.id, { why, at: this.now() });
    this.jobs.touchVoice();
    this.log(`Read-aloud: ended (${why})`);
    this.changed();
    this.jobs.notify();
    await this.workdir
      .removeSession(s.id)
      .catch((err) => this.logError('Read-aloud: could not remove a session folder:', err));
  }

  /** Every few seconds: a quiet device ends its session; a batch the PC lost waits again. */
  housekeep(): void {
    const now = this.now();
    for (const [id, e] of this.endedWhy) if (now - e.at > 3_600_000) this.endedWhy.delete(id);
    const s = this.session;
    if (!s) return;
    if (now - s.lastPollAt > this.config.readAloudDeviceIdleSeconds * 1000) {
      void this.end(s, 'idle');
      return;
    }
    const leaseMs = this.jobs.config.leaseSeconds * 1000;
    let moved = false;
    for (const b of s.batches.values()) {
      if (b.state === 'reading' && b.takenAt !== null && now - b.takenAt > leaseMs) {
        b.state = 'waiting';
        b.takenAt = null;
        moved = true;
      }
    }
    if (moved) {
      this.log('Read-aloud: a batch the PC took went back to waiting (the PC stopped answering)');
      this.changed();
    }
  }

  private view(s: Session, after: number): SessionView {
    return {
      id: s.id,
      bookId: s.bookId,
      state: 'open',
      ended: null,
      voice: {
        name: s.voice.name,
        dialogue: dialogueVoice(s.map)?.name ?? null,
        model: s.model.label,
        from: s.from,
      },
      batches: [...s.batches.values()]
        .filter((b) => b.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .map((b) => ({
          seq: b.seq,
          state: b.state,
          durationMs: b.durationMs,
          cues: b.cues,
          error: b.error,
        })),
      pc: this.pc(),
    };
  }

  private pc(): LivePcView {
    const st = this.db
      .prepare(
        'SELECT paused, last_seen_at, problem, worker_version FROM worker_status WHERE id = 1',
      )
      .get() as
      | {
          paused: number;
          last_seen_at: number | null;
          problem: string | null;
          worker_version: string | null;
        }
      | undefined;
    const now = this.now();
    const engine = this.jobs.engine();
    const busy = this.db
      .prepare(
        `SELECT j.kind, b.title FROM worker_jobs j LEFT JOIN books b ON b.id = j.book_id
         WHERE j.state = 'running' LIMIT 1`,
      )
      .get() as { kind: WorkerJobKind; title: string | null } | undefined;
    const waitMs = this.config.readAloudPcWaitSeconds * 1000;
    const online =
      !!st?.last_seen_at && now - st.last_seen_at <= this.jobs.config.offlineSeconds * 1000;
    return {
      online,
      lastSeenAt: st?.last_seen_at ?? null,
      paused: st?.paused === 1,
      problem: st?.problem ?? null,
      version: st?.worker_version ?? null,
      supportsLive:
        this.jobs.supportsLive() && (!this.session || this.pcReadsSession(this.session)),
      answering: this.pcAskedAt !== null && now - this.pcAskedAt <= waitMs,
      lastAskedAt: this.pcAskedAt,
      engine,
      busy: busy
        ? {
            kind: busy.kind,
            bookTitle: busy.title,
            yielding: ['generate_audiobook', 'preview_audiobook', 'voice_sample'].includes(
              busy.kind,
            ),
          }
        : null,
    };
  }
}

function bad(message: string): never {
  throw new JobRequestError(400, 'invalid_body', message);
}

/** The device's sentences, checked (book-script.ts's ScriptSentence). */
export function parseSentences(raw: unknown): ReadAloudSentence[] {
  if (!Array.isArray(raw) || raw.length === 0) bad('No sentences to read');
  if (raw.length > MAX_BATCH_SENTENCES) bad(`At most ${MAX_BATCH_SENTENCES} sentences at once`);
  return raw.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text : '';
    if (!text.trim() || text.length > MAX_TEXT) bad('A sentence is empty or too long');
    const reading = typeof o.reading === 'string' && o.reading !== '' ? o.reading : text;
    if (reading.length > MAX_READING) bad("A sentence's reading is too long");
    const ruby: RubyRun[] = [];
    if (Array.isArray(o.ruby)) {
      for (const x of o.ruby) {
        const y = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const start = y.start;
        const end = y.end;
        if (
          typeof start !== 'number' ||
          typeof end !== 'number' ||
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > text.length ||
          typeof y.rt !== 'string' ||
          y.rt === '' ||
          y.rt.length > 200
        ) {
          bad('A furigana run does not fit its sentence');
        }
        ruby.push({ start, end, rt: y.rt });
      }
    }
    const position =
      typeof o.position === 'number' && Number.isFinite(o.position) && o.position >= 0
        ? Math.round(o.position)
        : 0;
    const parts = parseParts(o.parts, text);
    return {
      text,
      reading,
      ruby,
      position,
      paragraphEnd: o.paragraphEnd === true,
      ...(parts ? { parts } : {}),
    };
  });
}

/** A sentence's dialogue runs from the device, checked (in order, inside the text). */
function parseParts(raw: unknown, text: string): DialoguePart[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 64) bad('The dialogue runs do not fit their sentence');
  const out: DialoguePart[] = [];
  let at = 0;
  for (const x of raw) {
    const y = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const { start, end, quote } = y;
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < at ||
      end <= start ||
      end > text.length ||
      typeof quote !== 'number' ||
      !Number.isInteger(quote) ||
      quote < 0
    ) {
      bad('The dialogue runs do not fit their sentence');
    }
    out.push({ start, end, role: 'dialogue', quote });
    at = end;
  }
  return out.length ? out : undefined;
}

/** One [start, end] ms pair per sentence, in order. */
function parseCues(raw: unknown, count: number): number[][] | null {
  if (!Array.isArray(raw) || raw.length !== count) return null;
  let last = 0;
  const out: number[][] = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length !== 2) return null;
    const [a, b] = c as unknown[];
    if (typeof a !== 'number' || typeof b !== 'number' || !(a >= last) || !(b >= a)) return null;
    out.push([Math.round(a), Math.round(b)]);
    last = b;
  }
  return out;
}
