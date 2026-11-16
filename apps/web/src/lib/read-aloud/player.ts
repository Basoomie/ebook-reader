/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 Phase 12 session 3: read-aloud's audio. One <audio> element plays every batch the
 * PC read, appended one after the other through Media Source Extensions ("sequence" mode),
 * so playback runs on by itself from batch to batch (also with the screen off), the speed
 * keeps the pitch, and the lock screen sees one media session. Each batch's sentence
 * timings are placed on that one timeline: the batch's real length is read from the
 * buffer after it is appended and its cues are scaled into it (MP3 adds a few ms at the
 * edges of every piece).
 *
 * Without Media Source support for MP3 (feature-detected), the element plays the batches
 * one by one from their own files instead.
 */

export interface TimedLine {
  /** The line (sentence) index in the book's script. */
  line: number;
  /** Seconds on the player's timeline. */
  start: number;
  end: number;
}

interface Segment {
  seq: number;
  /** Seconds on the player's timeline (MSE), or within its own file (fallback). */
  t0: number;
  t1: number;
  lines: TimedLine[];
  /** Fallback only: the batch's own file. */
  url?: string;
}

export const MSE_TYPE = 'audio/mpeg';
/** Played audio older than this is let go (seconds). */
const KEEP_BEHIND_SECONDS = 300;

export function mseSupported(win: Window = window): boolean {
  const MS = (win as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
  try {
    return !!MS && MS.isTypeSupported(MSE_TYPE);
  } catch {
    return false;
  }
}

/**
 * A batch's sentences on the timeline: its cues (ms in the batch's own audio) scaled to the
 * length the buffer really got, starting at `t0`.
 */
export function placeLines(
  lines: number[],
  cues: number[][],
  durationMs: number,
  t0: number,
  t1: number
): TimedLine[] {
  const scale = durationMs > 0 ? (t1 - t0) / (durationMs / 1000) : 1;
  return lines.map((line, i) => {
    const [a, b] = cues[i] ?? [0, 0];
    return { line, start: t0 + (a / 1000) * scale, end: t0 + (b / 1000) * scale };
  });
}

/**
 * The line playing at `t` among timed lines in order: the last line starting at or before
 * `t` (a pause after a sentence still belongs to it). Null before the first.
 */
export function lineAt(lines: TimedLine[], t: number): TimedLine | null {
  let lo = 0;
  let hi = lines.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (lines[mid].start <= t + 1e-3) lo = mid + 1;
    else hi = mid;
  }

  return lo > 0 ? lines[lo - 1] : null;
}

export class ReadAloudPlayer {
  readonly audio: HTMLAudioElement;
  readonly mse: boolean;
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private opened: Promise<void> | null = null;
  private objectUrl: string | null = null;
  private segments: Segment[] = [];
  /** Fallback: the segment the element plays. */
  private current = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly win: Window = window,
    private readonly onEndOfData: () => void = () => undefined
  ) {
    this.audio = new (win as unknown as { Audio: typeof Audio }).Audio();
    this.audio.preload = 'auto';
    this.mse = mseSupported(win);
    if (this.mse) {
      this.openSource();
    } else {
      this.audio.addEventListener('ended', () => this.nextFile());
    }
  }

  private openSource() {
    const MS = (this.win as unknown as { MediaSource: typeof MediaSource }).MediaSource;
    const source = new MS();
    this.source = source;
    this.buffer = null;
    const url = URL.createObjectURL(source);
    this.objectUrl = url;
    this.opened = new Promise((resolve) => {
      source.addEventListener(
        'sourceopen',
        () => {
          if (source !== this.source) return;
          const buffer = source.addSourceBuffer(MSE_TYPE);
          buffer.mode = 'sequence';
          this.buffer = buffer;
          resolve();
        },
        { once: true }
      );
    });
    this.audio.src = url;
  }

  private waitUpdate(buffer: SourceBuffer): Promise<void> {
    if (!buffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', fail);
        reject(new Error('The audio could not be added'));
      };
      buffer.addEventListener('updateend', done);
      buffer.addEventListener('error', fail);
    });
  }

  /** Runs buffer work one step at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Adds a batch the PC read: its lines (script indexes), cues (ms) and MP3 bytes. */
  append(
    seq: number,
    lines: number[],
    cues: number[][],
    durationMs: number,
    bytes: ArrayBuffer
  ): Promise<void> {
    return this.serial(async () => {
      if (this.destroyed) return;
      if (!this.mse) {
        const url = URL.createObjectURL(new Blob([bytes], { type: MSE_TYPE }));
        const t1 = durationMs / 1000;
        this.segments.push({
          seq,
          t0: 0,
          t1,
          lines: placeLines(lines, cues, durationMs, 0, t1),
          url
        });
        if (this.segments.length === 1) this.loadFile(0);
        return;
      }
      await this.opened;
      const buffer = this.buffer!;
      await this.waitUpdate(buffer);
      const t0 = buffer.timestampOffset;
      buffer.appendBuffer(bytes);
      await this.waitUpdate(buffer);
      const t1 = buffer.timestampOffset > t0 ? buffer.timestampOffset : t0 + durationMs / 1000;
      this.segments.push({ seq, t0, t1, lines: placeLines(lines, cues, durationMs, t0, t1) });
      await this.trimBehind();
    });
  }

  private async trimBehind() {
    const buffer = this.buffer;
    const before = this.audio.currentTime - KEEP_BEHIND_SECONDS;
    if (!buffer || before <= 0 || buffer.buffered.length === 0) return;
    if (buffer.buffered.start(0) >= before) return;
    buffer.remove(0, before);
    await this.waitUpdate(buffer);
    this.segments = this.segments.filter((s) => s.t1 > before);
  }

  private loadFile(index: number) {
    const seg = this.segments[index];
    if (!seg?.url) return;
    this.current = index;
    const wasPlaying = !this.audio.paused;
    const rate = this.audio.playbackRate;
    this.audio.src = seg.url;
    this.audio.playbackRate = rate;
    if (wasPlaying) void this.audio.play().catch(() => undefined);
  }

  private nextFile() {
    if (this.current + 1 < this.segments.length) {
      const rate = this.audio.playbackRate;
      this.loadFile(this.current + 1);
      this.audio.playbackRate = rate;
      void this.audio.play().catch(() => undefined);
    } else {
      this.onEndOfData();
    }
  }

  /** Every line with a time, in order (the current file only, in the fallback). */
  private timedLines(): TimedLine[] {
    if (!this.mse) return this.segments[this.current]?.lines ?? [];
    return this.segments.flatMap((s) => s.lines);
  }

  /** The line playing now (null before the first one is there). */
  currentLine(): number | null {
    return lineAt(this.timedLines(), this.audio.currentTime)?.line ?? null;
  }

  /** How far into the current line playback is (0..1), for following a long sentence. */
  currentProgress(): number {
    const l = lineAt(this.timedLines(), this.audio.currentTime);
    if (!l || l.end <= l.start) return 0;
    return Math.min(1, Math.max(0, (this.audio.currentTime - l.start) / (l.end - l.start)));
  }

  /** Whether the audio of `line` is here. */
  has(line: number): boolean {
    return this.segments.some((s) => s.lines.some((l) => l.line === line));
  }

  /** The last line whose audio is here, or null. */
  lastLine(): number | null {
    const seg = this.segments[this.segments.length - 1];
    return seg?.lines[seg.lines.length - 1]?.line ?? null;
  }

  /** Seconds of audio here after the current time. */
  aheadSeconds(): number {
    if (!this.mse) {
      const rest = this.segments.slice(this.current + 1).reduce((n, s) => n + (s.t1 - s.t0), 0);
      const now = this.segments[this.current];
      return rest + (now ? Math.max(0, now.t1 - this.audio.currentTime) : 0);
    }
    const last = this.segments[this.segments.length - 1];
    return last ? Math.max(0, last.t1 - this.audio.currentTime) : 0;
  }

  /**
   * Whether playback has reached the end of the audio here (it waits for more). An element
   * that runs out of data stops a little before the computed end (MP3 frames), so the end is
   * the buffer's own, with a quarter of a second to spare, or the element saying it has no
   * data ahead.
   */
  atEnd(): boolean {
    const last = this.segments[this.segments.length - 1];
    if (!last) return true;
    if (!this.mse) return this.current === this.segments.length - 1 && this.audio.ended;
    const buffered = this.buffer?.buffered;
    const bufferEnd = buffered && buffered.length ? buffered.end(buffered.length - 1) : last.t1;
    const end = Math.min(last.t1, bufferEnd);
    const t = this.audio.currentTime;
    if (t >= end - 0.25) return true;
    // HAVE_FUTURE_DATA (3): less means it can't go on from here.
    return !this.audio.paused && this.audio.readyState < 3 && t >= end - 1;
  }

  /** Jumps to the start of `line` if its audio is here. */
  seekLine(line: number): boolean {
    for (let i = 0; i < this.segments.length; i++) {
      const hit = this.segments[i].lines.find((l) => l.line === line);
      if (!hit) continue;
      if (!this.mse && i !== this.current) this.loadFile(i);
      this.audio.currentTime = hit.start;
      return true;
    }
    return false;
  }

  /** Throws away every batch (a jump beyond the audio here). */
  reset(): Promise<void> {
    return this.serial(async () => {
      if (!this.mse) {
        for (const s of this.segments) if (s.url) URL.revokeObjectURL(s.url);
        this.segments = [];
        this.current = 0;
        this.audio.removeAttribute('src');
        this.audio.load();
        return;
      }
      await this.opened;
      const buffer = this.buffer!;
      await this.waitUpdate(buffer);
      if (buffer.buffered.length) {
        buffer.remove(0, Infinity);
        await this.waitUpdate(buffer);
      }
      this.segments = [];
      // New audio continues the timeline; playback goes there.
      this.audio.currentTime = buffer.timestampOffset;
    });
  }

  set rate(rate: number) {
    this.audio.playbackRate = rate;
    this.audio.defaultPlaybackRate = rate;
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  get paused(): boolean {
    return this.audio.paused;
  }

  destroy() {
    this.destroyed = true;
    this.audio.pause();
    for (const s of this.segments) if (s.url) URL.revokeObjectURL(s.url);
    this.segments = [];
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.source = null;
    this.buffer = null;
  }
}
