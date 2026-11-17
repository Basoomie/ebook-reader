/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { ReadAloudPc, ReadAloudSession, TtsPauses } from '$lib/audio/tts-types';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import { ReadAloudPlayer } from './player';
import type { ReadAloudLine, ReadAloudScript } from './script';
import { endedText, waitingText } from './text';

/**
 * Season 2 Phase 12 session 3: live read-aloud with the PC's voice (decided with the user,
 * 2026-11-14/16). The controller on the reader page:
 *
 * - builds the book's sentences on this device (script.ts) and starts a session on the
 *   server (the book's PC voice, else the one in Settings > Anki);
 * - keeps "Read ahead" seconds of audio asked for: the first batch is one sentence (so the
 *   voice starts in seconds once the PC has the model loaded), the next three, then eight;
 *   at most two batches wait at the PC;
 * - holds a request open on the server (the session), fetches each batch the PC read and
 *   appends it to the player (player.ts), in order;
 * - tells the page which sentence is read and how far into it (the highlight and the
 *   following, follow.ts);
 * - pauses for a lookup popup (goes on after "Wait after a lookup"), when other audio on the
 *   page starts (one at a time with whispersync), and on the lock screen's Pause;
 * - when the audio runs out it waits at a sentence and says why (the PC is off, loading the
 *   voice, paused, busy…) and goes on by itself when the audio comes.
 *
 * Stats: nothing of its own; its page turns are the reader's (decided: like the pacer).
 */

export type ReadAloudPhase =
  | 'idle'
  | 'preparing'
  | 'playing'
  | 'waiting'
  | 'paused'
  | 'ended'
  | 'error';

export type PauseReason = 'you' | 'lookup' | 'other-audio';

export interface ReadAloudView {
  phase: ReadAloudPhase;
  pausedFor: PauseReason | null;
  /** The status line. */
  status: string;
  /** The voice and model of the session ("Narrator · Irodori v4.1 Small"), when known. */
  voice: string | null;
  voiceFrom: 'book' | 'global' | null;
  /** The sentence being read (script index), or null. */
  line: number | null;
  /** Read-aloud needs a voice chosen first (the panel shows the picker). */
  needsVoice: boolean;
}

export interface ReadAloudHost {
  api(): LibraryApi | null;
  /** The library book id, or null for a book outside the library. */
  bookId(): string | null;
  script(): Promise<ReadAloudScript>;
  pauses(): TtsPauses;
  speed(): number;
  aheadSeconds(): number;
  lookupResume(): number;
  /** The first counted character on the screen (where "Play" starts). */
  screenPosition(): number;
  /** The sentence being read and how far into it (null: nothing). */
  onLine(line: ReadAloudLine | null, progress: number): void;
  onView(view: ReadAloudView): void;
  /** Lock screen: the book's title, author and cover. */
  media(): { title: string; artist?: string; artwork?: string } | null;
  warn(message: string): void;
}

interface Pending {
  seq: number;
  lines: number[];
  gen: number;
  state: 'sent' | 'appending' | 'appended' | 'failed' | 'stale';
  error?: string;
}

const POLL_WAIT_SECONDS = 20;
const TICK_MS = 200;
const BATCH_SIZES = [1, 3];
const BATCH_SIZE = 8;
const MAX_IN_FLIGHT = 2;

export class ReadAloudController {
  private player: ReadAloudPlayer | null = null;
  private script: ReadAloudScript | null = null;
  private sessionId: string | null = null;
  private session: ReadAloudSession | null = null;
  private pc: ReadAloudPc | null = null;
  private pending = new Map<number, Pending>();
  private gen = 0;
  private batchNumber = 0;
  /** Next line to ask for. */
  private nextLine = 0;
  /** The line playback starts at after a (re)start, until its audio is here. */
  private startLine: number | null = null;
  private replaceNext = false;
  private sending = false;
  private acked = 0;
  private wantPlay = false;
  private pausedFor: PauseReason | null = null;
  private phase: ReadAloudPhase = 'idle';
  private status = '';
  private failure: { line: number; message: string } | null = null;
  private needsVoice = false;
  private pollAbort: AbortController | null = null;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lookupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLine: number | null = null;
  private destroyed = false;
  /** The player is being emptied (its element may report a pause that isn't the user's). */
  private resetting = false;
  private readonly onOtherPlay = (e: Event) => {
    const target = e.target;
    if (
      this.player &&
      target instanceof HTMLMediaElement &&
      target !== this.player.audio &&
      this.wantPlay
    ) {
      this.pause('other-audio');
    }
  };

  constructor(
    private readonly host: ReadAloudHost,
    private readonly win: Window = window,
    /** Tests: a stand-in for the audio. */
    private readonly createPlayer: (win: Window, onEnd: () => void) => ReadAloudPlayer = (
      w,
      onEnd
    ) => new ReadAloudPlayer(w, onEnd)
  ) {
    win.document.addEventListener('play', this.onOtherPlay, true);
  }

  // ------------------------------------------------------------------ the user's controls

  get playing(): boolean {
    return this.wantPlay;
  }

  /** Play (from the screen's first sentence, or where it paused). */
  async play(): Promise<void> {
    if (this.destroyed) return;
    this.ensurePlayer();
    this.pauseOtherMedia();
    // Inside the tap: lets the element play once audio is there.
    void this.player!.play().catch(() => undefined);
    this.wantPlay = true;
    this.pausedFor = null;
    if (this.failure) {
      const line = this.failure.line;
      this.failure = null;
      await this.restart(line);
      return;
    }
    if (
      !this.sessionId ||
      this.phase === 'ended' ||
      this.phase === 'idle' ||
      this.phase === 'error'
    ) {
      await this.startAt(this.host.screenPosition());
      return;
    }
    this.restartPoll();
    this.refresh();
  }

  pause(reason: PauseReason = 'you') {
    if (!this.wantPlay && this.pausedFor === reason) return;
    this.wantPlay = false;
    this.pausedFor = reason;
    this.player?.pause();
    this.restartPoll();
    this.refresh();
  }

  async toggle(): Promise<void> {
    if (this.wantPlay) this.pause('you');
    else await this.play();
  }

  /** "Read aloud from here" / "Read from here": starts at a reader position. */
  async readFrom(position: number): Promise<void> {
    this.ensurePlayer();
    this.pauseOtherMedia();
    void this.player!.play().catch(() => undefined);
    this.wantPlay = true;
    this.pausedFor = null;
    this.failure = null;
    if (!this.sessionId) {
      await this.startAt(position);
      return;
    }
    const script = await this.loadScript();
    const line = script.startAt(position);
    if (line < 0) return;
    await this.restart(line);
  }

  /** The next (+1) or previous (-1) sentence. */
  async skip(direction: 1 | -1): Promise<void> {
    if (!this.script || !this.player) return;
    const from = this.currentLine() ?? this.startLine ?? 0;
    const line = Math.min(this.script.lines.length - 1, Math.max(0, from + direction));
    if (this.player.seekLine(line)) {
      this.refresh();
      return;
    }
    await this.restart(line);
  }

  setSpeed(speed: number) {
    if (this.player) this.player.rate = speed;
  }

  /** A lookup popup opened ('start') or closed ('end'). */
  lookup(change: 'start' | 'end') {
    if (change === 'start') {
      if (this.lookupTimer) clearTimeout(this.lookupTimer);
      this.lookupTimer = null;
      if (this.wantPlay) this.pause('lookup');
      return;
    }
    if (this.pausedFor !== 'lookup') return;
    const seconds = this.host.lookupResume();
    if (!(seconds > 0)) return;
    if (this.lookupTimer) clearTimeout(this.lookupTimer);
    this.lookupTimer = setTimeout(() => {
      this.lookupTimer = null;
      if (this.pausedFor === 'lookup') void this.play();
    }, seconds * 1000);
  }

  /** Stop: the session ends on the server (the PC keeps the voice for the keep time). */
  async stop(): Promise<void> {
    const id = this.sessionId;
    this.endLocal();
    this.phase = 'idle';
    this.status = '';
    this.refresh();
    if (id)
      await this.host
        .api()
        ?.stopReadAloud(id)
        .catch(() => undefined);
  }

  destroy() {
    if (this.destroyed) return;
    const id = this.sessionId;
    this.endLocal();
    this.destroyed = true;
    this.win.document.removeEventListener('play', this.onOtherPlay, true);
    if (id)
      void this.host
        .api()
        ?.stopReadAloud(id)
        .catch(() => undefined);
  }

  // ------------------------------------------------------------------ inside

  private ensurePlayer() {
    if (this.player) return;
    this.player = this.createPlayer(this.win, () => this.refresh());
    this.player.rate = this.host.speed();
    const audio = this.player.audio;
    audio.addEventListener('timeupdate', () => this.refresh());
    audio.addEventListener('play', () => this.refresh());
    audio.addEventListener('pause', () => {
      // Paused from outside (the lock screen without our handler, the system).
      if (
        !this.resetting &&
        this.wantPlay &&
        !this.player?.atEnd() &&
        audio.paused &&
        this.phase === 'playing'
      ) {
        this.pause('you');
      }
    });
    this.setUpMediaSession();
  }

  private pauseOtherMedia() {
    for (const el of Array.from(this.win.document.querySelectorAll('audio, video'))) {
      const media = el as HTMLMediaElement;
      if (media !== this.player?.audio && !media.paused) media.pause();
    }
  }

  private setUpMediaSession() {
    const session = (this.win.navigator as Navigator & { mediaSession?: MediaSession })
      .mediaSession;
    if (!session) return;
    try {
      const media = this.host.media();
      const MM = (this.win as unknown as { MediaMetadata?: typeof MediaMetadata }).MediaMetadata;
      if (media && MM) {
        session.metadata = new MM({
          title: media.title,
          artist: media.artist ?? '',
          artwork: media.artwork ? [{ src: media.artwork }] : []
        });
      }
      const handle = (action: MediaSessionAction, fn: () => void) => {
        try {
          session.setActionHandler(action, fn);
        } catch {
          // Not supported by this browser.
        }
      };
      handle('play', () => void this.play());
      handle('pause', () => this.pause('you'));
      handle('stop', () => void this.stop());
      handle('previoustrack', () => void this.skip(-1));
      handle('nexttrack', () => void this.skip(1));
    } catch (error) {
      this.host.warn(`Read-aloud: lock-screen controls: ${(error as Error).message}`);
    }
  }

  private clearMediaSession() {
    const session = (this.win.navigator as Navigator & { mediaSession?: MediaSession })
      .mediaSession;
    if (!session) return;
    try {
      session.metadata = null;
      for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack'] as const) {
        session.setActionHandler(a, null);
      }
    } catch {
      // Not supported.
    }
  }

  private async loadScript(): Promise<ReadAloudScript> {
    this.script ??= await this.host.script();
    return this.script;
  }

  private async startAt(position: number) {
    this.phase = 'preparing';
    this.status = 'Getting the book ready…';
    this.needsVoice = false;
    this.refresh();
    try {
      const script = await this.loadScript();
      const api = this.host.api();
      if (!api)
        throw new LibraryApiError(
          'unreachable',
          'This device is not connected to the library server'
        );
      const line = script.startAt(position);
      if (line < 0) {
        this.phase = 'ended';
        this.status = 'Nothing left to read in this book.';
        this.refresh();
        return;
      }
      const session = await api.startReadAloud(this.host.bookId(), this.host.pauses());
      if (this.destroyed) {
        void api.stopReadAloud(session.id).catch(() => undefined);
        return;
      }
      this.sessionId = session.id;
      this.session = session;
      this.pc = session.pc;
      this.acked = 0;
      this.pending.clear();
      await this.restart(line);
      this.startTimer();
      void this.pollLoop();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown) {
    const e = error as LibraryApiError;
    this.wantPlay = false;
    this.player?.pause();
    this.phase = 'error';
    this.needsVoice = e?.code === 'voice_choice_off' || e?.code === 'bad_choice';
    this.status =
      e?.code === 'voice_choice_off'
        ? 'Choose a PC voice for this book (or one for every book in Settings > Anki).'
        : e?.kind === 'unreachable' || e?.kind === 'timeout'
          ? "The library server can't be reached. Read-aloud needs it and the PC."
          : (e?.message ?? String(error));
    this.refresh();
  }

  /** Reads from `line` on: everything asked for or here before is let go. */
  private async restart(line: number) {
    this.gen += 1;
    this.batchNumber = 0;
    this.nextLine = line;
    this.startLine = line;
    this.replaceNext = true;
    this.failure = null;
    for (const p of this.pending.values()) {
      if (p.state === 'sent' || p.state === 'appending') p.state = 'stale';
    }
    if (this.player) {
      this.resetting = true;
      try {
        await this.player.reset();
      } finally {
        this.resetting = false;
      }
      this.player.rate = this.host.speed();
      if (this.wantPlay) void this.player.play().catch(() => undefined);
    }
    this.refresh();
    void this.fillAhead();
  }

  private inFlight(): number {
    let n = 0;
    for (const p of this.pending.values()) {
      if (p.gen === this.gen && (p.state === 'sent' || p.state === 'appending')) n += 1;
    }
    return n;
  }

  /** Asks the PC for more sentences while less than "Read ahead" is here or on its way. */
  private async fillAhead() {
    if (this.sending || !this.sessionId || !this.script || !this.player) return;
    this.sending = true;
    try {
      // While less than "Read ahead" is here, at most two batches on their way.
      while (
        this.sessionId &&
        !this.failure &&
        this.nextLine < this.script.lines.length &&
        this.inFlight() < MAX_IN_FLIGHT &&
        this.player.aheadSeconds() < this.host.aheadSeconds()
      ) {
        const size = BATCH_SIZES[this.batchNumber] ?? BATCH_SIZE;
        const from = this.nextLine;
        const lines = this.script.lines.slice(from, from + size);
        const gen = this.gen;
        const replace = this.replaceNext;
        this.replaceNext = false;
        const seq = await this.host.api()!.readAloudBatch(
          this.sessionId,
          lines.map((l) => ({
            text: l.text,
            reading: l.reading,
            ruby: l.ruby,
            position: l.position,
            paragraphEnd: l.paragraphEnd,
            // Session 4: the dialogue runs (the server reads them with the dialogue voice).
            ...(l.parts ? { parts: l.parts } : {})
          })),
          replace
        );
        this.pending.set(seq, {
          seq,
          lines: lines.map((l) => l.index),
          gen,
          state: gen === this.gen ? 'sent' : 'stale'
        });
        if (gen !== this.gen) break;
        this.batchNumber += 1;
        this.nextLine = from + lines.length;
        this.restartPoll();
      }
    } catch (error) {
      if ((error as LibraryApiError)?.status === 410) this.ended(error as LibraryApiError);
      else this.host.warn(`Read-aloud: ${(error as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  private restartPoll() {
    this.pollAbort?.abort();
  }

  private async pollLoop() {
    if (this.polling) return;
    this.polling = true;
    let failures = 0;
    try {
      while (this.sessionId && !this.destroyed) {
        const id = this.sessionId;
        const api = this.host.api();
        if (!api) break;
        const abort = new AbortController();
        this.pollAbort = abort;
        try {
          const view = await api.readAloudPoll(
            id,
            { after: this.acked, wait: POLL_WAIT_SECONDS, playing: this.wantPlay },
            { signal: abort.signal }
          );
          failures = 0;
          if (id !== this.sessionId) break;
          this.session = view;
          this.pc = view.pc;
          await this.take(view);
        } catch (error) {
          const e = error as LibraryApiError;
          if (e?.kind === 'aborted') continue;
          if (e?.status === 410 || e?.status === 404) {
            this.ended(e);
            break;
          }
          failures += 1;
          this.pc = null;
          this.refresh();
          await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * failures)));
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Batches the PC finished: fetched and appended in order. */
  private async take(view: ReadAloudSession) {
    const byseq = new Map(view.batches.map((b) => [b.seq, b]));
    const seqs = [...this.pending.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const p = this.pending.get(seq)!;
      const b = byseq.get(seq);
      if (p.state === 'stale') continue;
      if (p.state === 'appended' || p.state === 'failed') continue;
      if (!b || b.state === 'waiting' || b.state === 'reading') break;
      if (b.state === 'failed') {
        p.state = 'failed';
        p.error = b.error ?? 'the PC could not read it';
        this.failure = { line: p.lines[0], message: p.error };
        break;
      }
      // done: fetch and append (in order; a later one waits for this one).
      p.state = 'appending';
      try {
        const bytes = await this.host.api()!.readAloudAudio(this.sessionId!, seq);
        if (p.gen !== this.gen) {
          p.state = 'stale';
          continue;
        }
        await this.player!.append(seq, p.lines, b.cues ?? [], b.durationMs ?? 0, bytes);
        p.state = 'appended';
        if (this.startLine !== null && p.lines.includes(this.startLine)) {
          // The first audio after a (re)start: playback goes to its sentence.
          this.player!.seekLine(this.startLine);
          this.startLine = null;
        }
        if (this.wantPlay && this.player!.paused) void this.player!.play().catch(() => undefined);
      } catch (error) {
        p.state = 'sent';
        this.host.warn(`Read-aloud: batch ${seq}: ${(error as Error).message}`);
        break;
      }
    }
    // Everything up to `acked` is handled (the server lets those files go).
    for (const seq of [...this.pending.keys()].sort((a, b) => a - b)) {
      const p = this.pending.get(seq)!;
      const b = byseq.get(seq);
      const handled =
        p.state === 'appended' ||
        p.state === 'failed' ||
        (p.state === 'stale' && (!b || b.state === 'done' || b.state === 'failed'));
      if (!handled) break;
      this.acked = Math.max(this.acked, seq);
      this.pending.delete(seq);
    }
    this.refresh();
    void this.fillAhead();
  }

  private ended(e: LibraryApiError) {
    const why = e.why ?? null;
    this.endLocal();
    this.phase = why ? 'error' : 'idle';
    this.status = endedText(why) ?? 'Read-aloud stopped.';
    this.refresh();
  }

  private endLocal() {
    this.sessionId = null;
    this.session = null;
    this.wantPlay = false;
    this.pollAbort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.lookupTimer) clearTimeout(this.lookupTimer);
    this.lookupTimer = null;
    this.player?.destroy();
    this.player = null;
    this.pending.clear();
    this.startLine = null;
    this.lastLine = null;
    this.clearMediaSession();
    this.host.onLine(null, 0);
  }

  private startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), TICK_MS);
  }

  private currentLine(): number | null {
    if (!this.player) return null;
    if (this.startLine !== null) return this.startLine;
    return this.player.currentLine();
  }

  /** Works out the phase and the line, and tells the page. */
  private refresh() {
    if (this.destroyed) return;
    const player = this.player;
    const script = this.script;
    if (this.sessionId && player && script) {
      const line = this.currentLine();
      const atEnd = this.startLine !== null || player.atEnd();
      const allHere =
        this.nextLine >= script.lines.length && this.inFlight() === 0 && this.startLine === null;
      if (this.failure && atEnd) {
        this.phase = 'error';
        this.status = `The PC couldn't read this part: ${this.failure.message}. Play tries again.`;
        if (this.wantPlay) {
          this.wantPlay = false;
          player.pause();
        }
      } else if (allHere && atEnd && player.lastLine() !== null) {
        this.phase = 'ended';
        this.status = 'The end of the book.';
        if (this.wantPlay) {
          this.wantPlay = false;
          player.pause();
        }
      } else if (!this.wantPlay) {
        this.phase = 'paused';
        this.status =
          this.pausedFor === 'lookup'
            ? 'Paused for the lookup.'
            : this.pausedFor === 'other-audio'
              ? 'Paused: other audio started.'
              : 'Paused.';
      } else if (atEnd) {
        this.phase = 'waiting';
        this.status = waitingText(this.pc);
      } else {
        this.phase = 'playing';
        this.status = 'Reading aloud.';
        if (player.paused) void player.play().catch(() => undefined);
      }
      const lineObj = line !== null ? (script.lines[line] ?? null) : null;
      this.host.onLine(lineObj, this.startLine !== null ? 0 : player.currentProgress());
      if (line !== this.lastLine) {
        this.lastLine = line;
        void this.fillAhead();
      }
      this.setPlaybackState();
    }
    const voice = this.session?.voice;
    this.host.onView({
      phase: this.phase,
      pausedFor: this.wantPlay ? null : this.pausedFor,
      status: this.status,
      voice: voice
        ? `${voice.name}${voice.dialogue ? `, dialogue ${voice.dialogue}` : ''}${
            voice.characters
              ? `, ${voice.characters} character ${voice.characters === 1 ? 'voice' : 'voices'}`
              : ''
          } · ${voice.model}`
        : null,
      voiceFrom: voice?.from ?? null,
      line: this.lastLine,
      needsVoice: this.needsVoice
    });
  }

  private setPlaybackState() {
    const session = (this.win.navigator as Navigator & { mediaSession?: MediaSession })
      .mediaSession;
    if (!session) return;
    try {
      session.playbackState = this.wantPlay ? 'playing' : 'paused';
    } catch {
      // Not supported.
    }
  }
}
