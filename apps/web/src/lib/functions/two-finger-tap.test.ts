/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TWO_FINGER_TAP_OPTIONS, TwoFingerTapDetector } from './two-finger-tap';

function detector(maxMove = 10) {
  return new TwoFingerTapDetector({ ...DEFAULT_TWO_FINGER_TAP_OPTIONS, getMaxMove: () => maxMove });
}

describe('TwoFingerTapDetector', () => {
  it('recognises two fingers down and up together', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 40);
    expect(d.up(1, 101, 100, 150)).toBe(false);
    expect(d.up(2, 200, 102, 170)).toBe(true);
  });

  it('ignores a single-finger tap', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    expect(d.up(1, 100, 100, 80)).toBe(false);
  });

  it('ignores two quick single taps one after the other', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    expect(d.up(1, 100, 100, 60)).toBe(false);
    d.down(2, 200, 100, 120);
    expect(d.up(2, 200, 100, 180)).toBe(false);
  });

  it('ignores a second finger that comes too late', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 300);
    d.up(1, 100, 100, 350);
    expect(d.up(2, 200, 100, 380)).toBe(false);
  });

  it('ignores fingers that stay down too long', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 20);
    d.up(1, 100, 100, 450);
    expect(d.up(2, 200, 100, 520)).toBe(false);
  });

  it('ignores a pinch or a two-finger swipe (movement past the swipe threshold)', () => {
    const d = detector(10);
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 20);
    d.move(2, 215, 100, 60);
    d.up(1, 100, 100, 120);
    expect(d.up(2, 215, 100, 140)).toBe(false);
  });

  it('accepts movement up to the threshold', () => {
    const d = detector(10);
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 20);
    d.up(1, 110, 100, 120);
    expect(d.up(2, 190, 110, 140)).toBe(true);
  });

  it('ignores three fingers', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 10);
    d.down(3, 300, 100, 20);
    d.up(1, 100, 100, 100);
    d.up(2, 200, 100, 110);
    expect(d.up(3, 300, 100, 120)).toBe(false);
  });

  it('ignores a cancelled pointer (browser took over the gesture)', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 20);
    d.cancel(1, 60);
    expect(d.up(2, 200, 100, 100)).toBe(false);
  });

  it('starts fresh after a spoiled gesture', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    d.down(2, 200, 100, 20);
    d.cancel(1, 60);
    d.up(2, 200, 100, 100);
    d.down(3, 100, 100, 1000);
    d.down(4, 200, 100, 1030);
    d.up(3, 100, 100, 1100);
    expect(d.up(4, 200, 100, 1120)).toBe(true);
  });

  it('remembers when two fingers were last down (for swallowing their clicks)', () => {
    const d = detector();
    d.down(1, 100, 100, 0);
    expect(d.lastMultiTouchAt).toBe(-Infinity);
    d.down(2, 200, 100, 30);
    d.up(1, 100, 100, 90);
    expect(d.lastMultiTouchAt).toBe(90);
    d.up(2, 200, 100, 120);
    expect(d.lastMultiTouchAt).toBe(90);
  });
});
