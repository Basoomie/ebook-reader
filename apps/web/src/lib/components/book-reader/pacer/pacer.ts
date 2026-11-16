/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { PAGE_CHANGE } from '$lib/data/events';
import { advance } from './pacer-clock';
import {
  currentIndex,
  planPaint,
  readingEnd,
  readingStart,
  sameSpans,
  type PacerMode,
  type Spans
} from './pacer-plan';
import { PacerPage, type PacerPageHost, type PacerSnapshot } from './pacer-page';
import { sentenceUnits } from './pacer-units';

/**
 * Season 2 pacer (decided with the user, 2026-11-14/15): paragraph mode, text reveal,
 * disappearing text (reveal and disappearing together), at a speed in characters per hour,
 * in steps (sentence or line) in E-ink mode.
 *
 * The reading point is an absolute position in the reader's counted characters. While
 * running it moves at the speed up to the end of the text on the screen; there it turns
 * the page (paginated: the reader's own next page; continuous: scrolls the next line to
 * the start of the screen) or waits. A page turn or scroll that takes the point off the
 * screen (yours, a jump, a relayout) moves it to the first character on the screen. The
 * tracker isn't touched: the pacer's page turns are the reader's own.
 *
 * Isolated: every step is guarded; a failure is logged, the painting is cleared and the
 * pacer stops. Reading goes on unchanged.
 */

export interface PacerSettings {
  mode: PacerMode;
  /** Counted characters per hour. */
  speed: number;
  turnPages: boolean;
  keep: number;
  einkStep: 'sentence' | 'line';
  /** Seconds after a lookup closes; 0 = stay paused. */
  lookupResume: number;
  /** Minutes without input before the pacer pauses; 0 = never. */
  idleMinutes: number;
  /** Seconds on a page without text before turning it. */
  textlessSeconds: number;
  eink: boolean;
}

export type PacerPauseReason = 'dialog' | 'hidden' | 'lookup' | 'layout' | 'selection';

export interface PacerState {
  /** Started by the user and not paused by the user (or idle / book end). */
  running: boolean;
  /** Automatic pauses in effect. */
  pausedFor: PacerPauseReason[];
  /** Reached the end of the book. */
  ended: boolean;
  failed: boolean;
}

export interface PacerView {
  readonly supported: boolean;
  measure(): PacerSnapshot | null;
  lineSteps(snapshot: PacerSnapshot): number[];
  scrollToChar(snapshot: PacerSnapshot, index: number, smooth: boolean): boolean;
  paint(snapshot: PacerSnapshot, spans: Spans, eink: boolean): void;
  clear(): void;
  destroy(): void;
}

export interface PacerHost {
  paginated(): boolean;
  settings(): PacerSettings;
  /** The reader's next page (paginated mode). */
  nextPage(): void;
  onState(state: PacerState): void;
  warn(message: string): void;
}

export interface PacerTimers {
  now(): number;
  frame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout> | undefined): void;
}

/** Waits after a scroll before measuring again (the page is still moving). */
const SCROLL_SETTLE_MS = 120;

/** A page turn that changes nothing for this long: the end of the book. */
const TURN_TIMEOUT_MS = 3000;

export class Pacer {
  private point: number | null = null;

  private running = false;

  private ended = false;

  private failed = false;

  private auto = new Set<PacerPauseReason>();

  private snap: PacerSnapshot | null = null;

  private steps: number[] | null = null;

  private stepsFor = '';

  private lastSpans: Spans | null = null;

  private dirty = true;

  private dirtyAt = 0;

  private frameId: number | undefined;

  private lastTime: number | undefined;

  private turnKey: string | undefined;

  private turnAt = 0;

  private textlessSince: number | undefined;

  private lastInput: number;

  private lookupTimer: ReturnType<typeof setTimeout> | undefined;

  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  private destroyed = false;

  private lastState = '';

  constructor(
    private view: PacerView,
    private host: PacerHost,
    private timers: PacerTimers
  ) {
    this.lastInput = timers.now();
  }

  get supported() {
    return this.view.supported;
  }

  /** The reading point (absolute counted characters), for tests and the panel. */
  get position() {
    return this.point;
  }

  state(): PacerState {
    return {
      running: this.running,
      pausedFor: [...this.auto],
      ended: this.ended,
      failed: this.failed
    };
  }

  start() {
    if (this.destroyed || !this.view.supported) return;

    this.guard(() => {
      this.running = true;
      this.ended = false;
      this.failed = false;
      this.turnKey = undefined;
      this.lastInput = this.timers.now();
      this.resync();
      this.emit();
      this.loop();
    });
  }

  pause() {
    this.running = false;
    this.emit();
  }

  toggle() {
    if (this.running) this.pause();
    else this.start();
  }

  /** An automatic pause starts or ends; the pacer goes on when the last one ends. */
  setPaused(reason: PacerPauseReason, on: boolean) {
    if (this.destroyed) return;

    const had = this.auto.has(reason);

    if (on === had) return;

    if (on) {
      this.auto.add(reason);
    } else {
      this.auto.delete(reason);
    }

    this.lastTime = undefined;
    this.emit();
    this.loop();
  }

  /** A dictionary popup opened ('start') or closed ('end'). */
  lookup(change: 'start' | 'end') {
    if (this.destroyed) return;

    this.input();
    this.timers.clearTimeout(this.lookupTimer);
    this.lookupTimer = undefined;

    if (change === 'start') {
      this.setPaused('lookup', true);
      return;
    }

    if (!this.auto.has('lookup')) return;

    const seconds = Math.max(0, Number(this.host.settings().lookupResume) || 0);

    if (seconds <= 0) {
      // 0 = stay paused until resumed by hand.
      this.running = false;
      this.setPaused('lookup', false);
      return;
    }

    this.lookupTimer = this.timers.setTimeout(() => {
      this.lookupTimer = undefined;
      this.setPaused('lookup', false);
    }, seconds * 1000);
  }

  /** Touch, key, mouse or wheel from the user (for the idle pause). */
  input() {
    this.lastInput = this.timers.now();
  }

  /**
   * The page may have changed (page turn, scroll, resize, new content). Scrolls wait until
   * the page stops moving; the rest is measured on the next frame.
   */
  invalidate(immediate: boolean) {
    if (this.destroyed) return;

    this.dirty = true;
    this.dirtyAt = immediate ? 0 : this.timers.now();

    if (!this.moving()) {
      this.timers.clearTimeout(this.settleTimer);
      this.settleTimer = this.timers.setTimeout(
        () => this.guard(() => this.resync()),
        immediate ? 0 : SCROLL_SETTLE_MS
      );
    }
  }

  /** A setting changed: paint again with it. */
  refresh() {
    if (this.destroyed) return;

    this.guard(() => {
      this.stepsFor = '';
      this.lastSpans = null;
      this.paint();
    });
  }

  destroy() {
    this.destroyed = true;
    this.running = false;
    this.stopLoop();
    this.timers.clearTimeout(this.lookupTimer);
    this.timers.clearTimeout(this.settleTimer);

    try {
      this.view.destroy();
    } catch (error) {
      this.host.warn(`Pacer: ${(error as Error)?.message ?? error}`);
    }
  }

  // ---------------------------------------------------------------------------

  private moving() {
    return this.running && !this.ended && !this.failed && this.auto.size === 0;
  }

  private emit() {
    const state = this.state();
    const key = JSON.stringify(state);

    if (key === this.lastState) return;

    this.lastState = key;

    try {
      this.host.onState(state);
    } catch (error) {
      this.host.warn(`Pacer: ${(error as Error)?.message ?? error}`);
    }
  }

  private guard(fn: () => void) {
    try {
      fn();
    } catch (error) {
      this.host.warn(`Pacer stopped: ${(error as Error)?.message ?? error}`);
      this.failed = true;
      this.running = false;
      this.stopLoop();

      try {
        this.view.clear();
      } catch {
        // Nothing more to do.
      }

      this.emit();
    }
  }

  private loop() {
    if (this.destroyed || !this.moving()) {
      this.stopLoop();
      return;
    }

    if (this.frameId === undefined) {
      this.frameId = this.timers.frame((now) => {
        this.frameId = undefined;
        this.guard(() => this.tick(now));
        this.loop();
      });
    }
  }

  private stopLoop() {
    if (this.frameId !== undefined) {
      this.timers.cancelFrame(this.frameId);
      this.frameId = undefined;
    }

    this.lastTime = undefined;
  }

  /** Measures the page and moves the point onto it if it isn't there. */
  private resync() {
    this.dirty = false;
    const snap = this.view.measure();
    this.snap = snap;
    this.stepsFor = '';
    this.lastSpans = null;

    if (!snap) return;

    if (this.turnKey !== undefined && snap.key !== this.turnKey) {
      this.turnKey = undefined;
    }

    if (snap.firstVisible < 0) {
      this.textlessSince ??= this.timers.now();
    } else {
      this.textlessSince = undefined;
      const start =
        readingStart(snap.chars, snap.firstVisible, snap.lastVisible) ??
        snap.chars[snap.firstVisible].start;
      const end = readingEnd(snap.chars, snap.firstVisible, snap.lastVisible) ?? start;

      if (this.point === null || this.point < start || this.point > end) {
        this.point = start;
      }
    }

    this.paint();
  }

  private stepsOf(snap: PacerSnapshot, settings: PacerSettings): number[] | null {
    if (!settings.eink || settings.mode === 'paragraph' || settings.mode === 'off') {
      return null;
    }

    const want = `${snap.key}|${settings.einkStep}|${snap.chars.length}`;

    if (want !== this.stepsFor) {
      this.stepsFor = want;
      this.steps =
        settings.einkStep === 'line'
          ? this.view.lineSteps(snap)
          : sentenceUnits(snap.chars, (i) => {
              const c = snap.chars[i];
              return c.gaiji ? '〓' : (c.node.textContent ?? '').slice(c.offset, c.offset + c.len);
            });
    }

    return this.steps;
  }

  private paint() {
    const snap = this.snap;

    if (!snap || this.point === null) return;

    const settings = this.host.settings();
    const spans = planPaint({
      chars: snap.chars,
      point: this.point,
      mode: settings.mode,
      keep: Math.max(1, Number(settings.keep) || 1),
      paragraphs: snap.paragraphs,
      steps: this.stepsOf(snap, settings)
    });

    if (this.lastSpans && sameSpans(spans, this.lastSpans)) return;

    this.lastSpans = spans;
    this.view.paint(snap, spans, settings.eink);
  }

  private tick(now: number) {
    if (this.dirty && (this.dirtyAt === 0 || now - this.dirtyAt >= SCROLL_SETTLE_MS)) {
      this.resync();
    }

    const elapsed = this.lastTime === undefined ? 0 : now - this.lastTime;
    this.lastTime = now;
    const settings = this.host.settings();
    const snap = this.snap;

    if (settings.idleMinutes > 0 && now - this.lastInput >= settings.idleMinutes * 60_000) {
      this.pause();
      return;
    }

    if (this.turnKey !== undefined) {
      if (now - this.turnAt >= TURN_TIMEOUT_MS) {
        // The page didn't change: the end of the book.
        this.turnKey = undefined;
        this.ended = true;
        this.running = false;
        this.emit();
      }

      return;
    }

    if (!snap || this.dirty) return;

    if (snap.firstVisible < 0) {
      const since = this.textlessSince ?? now;

      if (settings.turnPages && now - since >= Math.max(0, settings.textlessSeconds) * 1000) {
        this.turn(snap, settings);
      }

      return;
    }

    const limit = readingEnd(snap.chars, snap.firstVisible, snap.lastVisible);

    if (limit === null || this.point === null) return;

    this.point = advance(this.point, elapsed, settings.speed, limit);
    this.paint();

    if (this.point >= limit && settings.turnPages) {
      this.turn(snap, settings);
    }
  }

  private turn(snap: PacerSnapshot, settings: PacerSettings) {
    this.turnKey = snap.key;
    this.turnAt = this.timers.now();

    if (this.host.paginated()) {
      this.host.nextPage();
      return;
    }

    const next = this.point === null ? -1 : currentIndex(snap.chars, this.point);
    const target =
      next >= 0 && snap.chars[next] && snap.chars[next].end > (this.point ?? 0)
        ? next
        : Math.min(snap.lastVisible + 1, snap.chars.length - 1);

    if (target <= snap.lastVisible || !this.view.scrollToChar(snap, target, !settings.eink)) {
      // Nothing after the screen: wait for the timeout (end of the book).
      return;
    }
  }
}

/**
 * The listeners a pacer needs on the reader page. Returns a function that removes them.
 * Only created while the pacer exists (its mode isn't Off and it was started once).
 */
export function listenForPacer(pacer: Pacer, win: Window = window) {
  const doc = win.document;
  const passive = { capture: true, passive: true } as const;
  const onPageChange = () => pacer.invalidate(true);
  const onScroll = () => pacer.invalidate(false);
  const onResize = () => pacer.invalidate(false);
  const onVisibility = () => pacer.setPaused('hidden', doc.visibilityState === 'hidden');
  const onInput = () => pacer.input();
  const inputs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

  doc.addEventListener(PAGE_CHANGE, onPageChange);
  win.addEventListener('scroll', onScroll, passive);
  win.addEventListener('resize', onResize);
  doc.addEventListener('visibilitychange', onVisibility);
  inputs.forEach((type) => win.addEventListener(type, onInput, passive));
  onVisibility();

  return () => {
    doc.removeEventListener(PAGE_CHANGE, onPageChange);
    win.removeEventListener('scroll', onScroll, passive);
    win.removeEventListener('resize', onResize);
    doc.removeEventListener('visibilitychange', onVisibility);
    inputs.forEach((type) => win.removeEventListener(type, onInput, passive));
  };
}

export interface CreatePacerOptions {
  page: PacerPageHost;
  host: PacerHost;
  win?: Window;
}

/** The pacer for the reader page, with its listeners. */
export function createPacer({ page, host, win = window }: CreatePacerOptions) {
  const holder: { pacer?: Pacer } = {};
  const view = new PacerPage(page, (immediate) => holder.pacer?.invalidate(immediate), win);
  const pacer = new Pacer(view, host, {
    now: () => win.performance.now(),
    frame: (cb) => win.requestAnimationFrame(cb),
    cancelFrame: (id) => win.cancelAnimationFrame(id),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id)
  });
  holder.pacer = pacer;
  const stopListening = listenForPacer(pacer, win);
  const destroy = pacer.destroy.bind(pacer);
  pacer.destroy = () => {
    stopListening();
    destroy();
  };
  return pacer;
}
