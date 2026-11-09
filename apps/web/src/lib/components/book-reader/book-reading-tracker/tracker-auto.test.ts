/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  AutoStartGate,
  RESIZE_PAGE_CHANGE_GUARD_MS,
  shouldAutoResume,
  type AutoResumeInput
} from './tracker-auto';

describe('AutoStartGate', () => {
  const layoutDone = 10_000;

  it('ignores page changes while the book settles, then starts on the first page turn', () => {
    const gate = new AutoStartGate(3000);

    // First position report after layout, then position restore: both settle only.
    expect(gate.onPageChange(layoutDone, true)).toBe(false);
    expect(gate.onPageChange(layoutDone + 1500, true)).toBe(false);

    // First page turn after 3 s of quiet.
    expect(gate.onPageChange(layoutDone + 6000, true)).toBe(true);
    expect(gate.isDone).toBe(true);
  });

  it('never treats the first position report as a page turn, however late layout finishes', () => {
    const gate = new AutoStartGate(3000);

    // Slow device: layout finishes a minute after the reader mounted.
    expect(gate.onPageChange(layoutDone + 60_000, true)).toBe(false);
    expect(gate.isDone).toBe(false);
  });

  it('a page turn within the settle period only extends it', () => {
    const gate = new AutoStartGate(3000);

    gate.onPageChange(layoutDone, true);
    expect(gate.onPageChange(layoutDone + 2000, true)).toBe(false);
    expect(gate.onPageChange(layoutDone + 4000, true)).toBe(false);
    expect(gate.onPageChange(layoutDone + 7000, true)).toBe(true);
  });

  it('fires at most once per book load', () => {
    const gate = new AutoStartGate(1000);

    gate.onPageChange(layoutDone, true);
    expect(gate.onPageChange(layoutDone + 5000, true)).toBe(true);
    expect(gate.onPageChange(layoutDone + 9000, true)).toBe(false);
  });

  it('is skipped after a manual toggle', () => {
    const gate = new AutoStartGate(1000);

    gate.onPageChange(layoutDone, true);
    gate.cancel();

    expect(gate.onPageChange(layoutDone + 5000, true)).toBe(false);
  });

  it('stands down when the tracker is already running', () => {
    const gate = new AutoStartGate(1000);

    gate.onPageChange(layoutDone, true);
    expect(gate.onPageChange(layoutDone + 5000, false)).toBe(false);
    expect(gate.onPageChange(layoutDone + 9000, true)).toBe(false);
  });

  it('treats a programmatic jump as settling, however late it lands', () => {
    const gate = new AutoStartGate(3000);

    gate.onPageChange(layoutDone, true);
    // The prompt is answered long after the book settled; the jump lands 5 s later.
    gate.noteSettling(layoutDone + 20_000);
    expect(gate.onPageChange(layoutDone + 25_000, true)).toBe(false);
    // A page turn right after the jump only extends the settle period...
    expect(gate.onPageChange(layoutDone + 26_000, true)).toBe(false);
    // ...and the first turn after 3 s of quiet starts the tracker.
    expect(gate.onPageChange(layoutDone + 30_000, true)).toBe(true);
  });

  it('a jump before the first position report still needs a quiet page turn', () => {
    const gate = new AutoStartGate(3000);

    gate.noteSettling(layoutDone);
    expect(gate.onPageChange(layoutDone + 10_000, true)).toBe(false);
    expect(gate.onPageChange(layoutDone + 14_000, true)).toBe(true);
  });

  it('ignores a jump once it has fired or been cancelled', () => {
    const gate = new AutoStartGate(1000);

    gate.cancel();
    gate.noteSettling(layoutDone);
    expect(gate.onPageChange(layoutDone + 5000, true)).toBe(false);
    expect(gate.isDone).toBe(true);
  });

  it('is off when the setting is 0', () => {
    const gate = new AutoStartGate(0);

    expect(gate.isDone).toBe(true);
    gate.onPageChange(layoutDone, true);
    expect(gate.onPageChange(layoutDone + 5000, true)).toBe(false);
  });
});

describe('shouldAutoResume', () => {
  const base: AutoResumeInput = {
    pausedByIdle: true,
    isTrackerPaused: true,
    charCountAtPause: 1200,
    currentCharCount: 1650,
    now: 100_000,
    lastResizeAt: 0
  };

  it('resumes an idle pause on a page turn or scroll', () => {
    expect(shouldAutoResume(base)).toBe(true);
    expect(shouldAutoResume({ ...base, currentCharCount: 900 })).toBe(true);
  });

  it('never resumes a manual pause', () => {
    expect(shouldAutoResume({ ...base, pausedByIdle: false })).toBe(false);
  });

  it('does nothing when the tracker is already running', () => {
    expect(shouldAutoResume({ ...base, isTrackerPaused: false })).toBe(false);
  });

  it('needs the character position to change', () => {
    expect(shouldAutoResume({ ...base, currentCharCount: base.charCountAtPause })).toBe(false);
  });

  it('ignores page changes right after a window resize', () => {
    expect(
      shouldAutoResume({ ...base, lastResizeAt: base.now - RESIZE_PAGE_CHANGE_GUARD_MS + 100 })
    ).toBe(false);
    expect(
      shouldAutoResume({ ...base, lastResizeAt: base.now - RESIZE_PAGE_CHANGE_GUARD_MS })
    ).toBe(true);
  });

  it('accepts a custom resize guard', () => {
    expect(shouldAutoResume({ ...base, lastResizeAt: base.now - 500, resizeGuardMs: 200 })).toBe(
      true
    );
  });
});
