/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Pure decision logic for the hands-free tracker (auto-start and auto-resume).
 * Kept free of Svelte and DOM so it can be unit tested; the components only feed
 * it timestamps and character counts.
 */

/**
 * Page changes within this window after a window resize are treated as layout
 * shifts (e.g. a phone address bar showing or hiding), not as page turns.
 * Same value as the reader's existing resize debounce in routes/b/+page.svelte.
 */
export const RESIZE_PAGE_CHANGE_GUARD_MS = 1000;

/**
 * Decides when the tracker auto-starts after a book is opened.
 *
 * Page changes fired while the book loads must not start the tracker. The first
 * position report after layout is never a page turn; it starts the settle period.
 * Each further page change within `guardMs` of the previous one (position restore,
 * layout) only extends it. The first page change after the reader has been settled
 * for `guardMs` counts as the first page turn and starts the tracker. Layout can
 * take arbitrarily long on slow devices, so the clock does not start at mount time.
 * Fires at most once per book load.
 */
export class AutoStartGate {
  private lastChangeAt: number | undefined;

  private done: boolean;

  /** The next page change is a programmatic jump, not a page turn. */
  private holdNext = false;

  constructor(private readonly guardMs: number) {
    this.done = guardMs <= 0;
  }

  get isDone() {
    return this.done;
  }

  /** Stops the gate for this book load (manual toggle, or tracker already running). */
  cancel() {
    this.done = true;
  }

  /**
   * A programmatic jump is about to happen (e.g. "Continue from...?"). Its page
   * change is treated as settling, however long the jump takes to land (a
   * paginated jump may first load another section), and the settle period
   * restarts from it. If the jump causes no page change, the next page change
   * is treated as settling instead, which only delays the auto-start by one turn.
   */
  noteSettling(now: number) {
    if (this.done) {
      return;
    }

    this.holdNext = true;
    this.lastChangeAt = now;
  }

  /** Returns true when this page change should start the tracker. */
  onPageChange(now: number, isTrackerPaused: boolean) {
    if (this.done) {
      return false;
    }

    if (this.holdNext && isTrackerPaused) {
      this.holdNext = false;
      this.lastChangeAt = now;
      return false;
    }

    if (!isTrackerPaused) {
      this.done = true;
      return false;
    }

    if (this.lastChangeAt === undefined || now - this.lastChangeAt < this.guardMs) {
      this.lastChangeAt = now;
      return false;
    }

    this.done = true;

    return true;
  }
}

export interface AutoResumeInput {
  /** The current pause was triggered by the idle timeout. */
  pausedByIdle: boolean;
  isTrackerPaused: boolean;
  /** Character position when the idle pause happened. */
  charCountAtPause: number;
  /** Character position reported by the page change. */
  currentCharCount: number;
  now: number;
  /** Time of the last window resize (0 if none). */
  lastResizeAt: number;
  resizeGuardMs?: number;
}

/**
 * A page turn or scroll (a change of the explored character count) after an idle
 * pause resumes tracking. Manual pauses never auto-resume.
 */
export function shouldAutoResume({
  pausedByIdle,
  isTrackerPaused,
  charCountAtPause,
  currentCharCount,
  now,
  lastResizeAt,
  resizeGuardMs = RESIZE_PAGE_CHANGE_GUARD_MS
}: AutoResumeInput) {
  if (!pausedByIdle || !isTrackerPaused) {
    return false;
  }

  if (currentCharCount === charCountAtPause) {
    return false;
  }

  return !lastResizeAt || now - lastResizeAt >= resizeGuardMs;
}
