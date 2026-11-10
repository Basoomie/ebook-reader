/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { decideMouseDrag, type MouseDragInput } from './mouse-drag';

function drag(overrides: Partial<MouseDragInput>): MouseDragInput {
  return {
    dx: -120,
    dy: 5,
    durationMs: 900,
    selectionCollapsed: true,
    threshold: 80,
    paginated: true,
    swipeThreshold: 10,
    verticalMode: false,
    ...overrides
  };
}

describe('decideMouseDrag', () => {
  it('turns to the next page on a slow left drag in horizontal text', () => {
    expect(decideMouseDrag(drag({}))).toBe('next');
    expect(decideMouseDrag(drag({ dx: 120 }))).toBe('prev');
  });

  it('swaps direction in vertical text (like a swipe)', () => {
    expect(decideMouseDrag(drag({ verticalMode: true }))).toBe('prev');
    expect(decideMouseDrag(drag({ verticalMode: true, dx: 120 }))).toBe('next');
  });

  it('does nothing when the drag selected text', () => {
    expect(decideMouseDrag(drag({ selectionCollapsed: false }))).toBeNull();
  });

  it('needs the threshold distance', () => {
    expect(decideMouseDrag(drag({ dx: -79 }))).toBeNull();
    expect(decideMouseDrag(drag({ dx: -80 }))).toBe('next');
  });

  it('needs a mostly horizontal drag', () => {
    expect(decideMouseDrag(drag({ dx: -120, dy: 70 }))).toBeNull();
    expect(decideMouseDrag(drag({ dx: -120, dy: 60 }))).toBe('next');
  });

  it('leaves quick flicks in paginated mode to the existing swipe (no double turn)', () => {
    expect(decideMouseDrag(drag({ durationMs: 200 }))).toBeNull();
    expect(decideMouseDrag(drag({ durationMs: 200, selectionCollapsed: false }))).toBeNull();
  });

  it('handles quick flicks itself in continuous mode (no swipe there)', () => {
    expect(decideMouseDrag(drag({ durationMs: 200, paginated: false }))).toBe('next');
    expect(
      decideMouseDrag(drag({ durationMs: 200, paginated: false, selectionCollapsed: false }))
    ).toBeNull();
  });

  it('turns a quick but short paginated drag only when the swipe would not', () => {
    // Below the swipe distance: the swipe ignores it and so does the drag (below threshold).
    expect(decideMouseDrag(drag({ durationMs: 200, dx: -8 }))).toBeNull();
    // Diagonal quick drag: not a swipe, and not horizontal enough for a drag either.
    expect(decideMouseDrag(drag({ durationMs: 200, dx: -120, dy: 80 }))).toBeNull();
  });
});
