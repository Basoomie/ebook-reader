/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

export interface TwoFingerTapOptions {
  /** Most time (ms) between the first and the second finger touching down. */
  maxStartGapMs: number;
  /** Most time (ms) from the first finger down until both fingers are up. */
  maxDurationMs: number;
  /** Most movement (px) of each finger. Read on every gesture. */
  getMaxMove: () => number;
}

export const DEFAULT_TWO_FINGER_TAP_OPTIONS: Omit<TwoFingerTapOptions, 'getMaxMove'> = {
  maxStartGapMs: 250,
  maxDurationMs: 500
};

interface TrackedPointer {
  startX: number;
  startY: number;
}

/**
 * WP10a: recognises a two-finger tap from touch pointer events (no DOM access, so it can be
 * unit tested). Exactly two fingers must touch down close together, stay (almost) still and
 * both lift soon after. A third finger, a moving finger (swipe, pinch) or a cancelled pointer
 * spoils the gesture. Single-finger taps and swipes never involve it.
 */
export class TwoFingerTapDetector {
  private pointers = new Map<number, TrackedPointer>();

  private firstDownAt = 0;

  private touchCount = 0;

  private spoiled = false;

  /** Last time two or more fingers were down at once (for swallowing their clicks). */
  lastMultiTouchAt = -Infinity;

  constructor(private options: TwoFingerTapOptions) {}

  down(id: number, x: number, y: number, now: number) {
    if (!this.pointers.size) {
      this.firstDownAt = now;
      this.touchCount = 0;
      this.spoiled = false;
    }

    this.touchCount += 1;
    this.pointers.set(id, { startX: x, startY: y });

    if (this.pointers.size > 1) {
      this.lastMultiTouchAt = now;
    }

    if (this.touchCount > 2) {
      this.spoiled = true;
    } else if (this.touchCount === 2 && now - this.firstDownAt > this.options.maxStartGapMs) {
      this.spoiled = true;
    }
  }

  move(id: number, x: number, y: number, now: number) {
    const pointer = this.pointers.get(id);

    if (!pointer) {
      return;
    }

    if (this.pointers.size > 1) {
      this.lastMultiTouchAt = now;
    }

    const maxMove = Math.max(0, this.options.getMaxMove());

    if (Math.abs(x - pointer.startX) > maxMove || Math.abs(y - pointer.startY) > maxMove) {
      this.spoiled = true;
    }
  }

  /** Returns true when this release completes a two-finger tap. */
  up(id: number, x: number, y: number, now: number) {
    if (!this.pointers.has(id)) {
      return false;
    }

    this.move(id, x, y, now);

    if (this.pointers.size > 1) {
      this.lastMultiTouchAt = now;
    }

    this.pointers.delete(id);

    if (this.pointers.size) {
      return false;
    }

    return (
      !this.spoiled && this.touchCount === 2 && now - this.firstDownAt <= this.options.maxDurationMs
    );
  }

  cancel(id: number, now: number) {
    if (!this.pointers.has(id)) {
      return;
    }

    if (this.pointers.size > 1) {
      this.lastMultiTouchAt = now;
    }

    this.spoiled = true;
    this.pointers.delete(id);
  }
}
