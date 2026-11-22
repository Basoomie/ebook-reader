/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { closeDistance, firstMove, releaseCloses, releaseSpeed } from './sheet-swipe';

describe('sheet swipe', () => {
  it('waits inside the slop, then drags only downwards', () => {
    expect(firstMove(1, 2, 10)).toBe('wait');
    expect(firstMove(0, 6, 10)).toBe('drag');
    expect(firstMove(2, 6, 10)).toBe('drag');
    expect(firstMove(0, -6, 10)).toBe('native');
    expect(firstMove(8, 4, 10)).toBe('native');
  });

  it('leaves a long press (selecting text) to the browser', () => {
    expect(firstMove(0, 10, 600)).toBe('native');
  });

  it('closes past a share of the sheet, within bounds', () => {
    expect(closeDistance(100)).toBe(72);
    expect(closeDistance(400)).toBe(120);
    expect(closeDistance(900)).toBe(200);
    expect(releaseCloses(119, 0, 400)).toBe(false);
    expect(releaseCloses(120, 0, 400)).toBe(true);
  });

  it('closes on a flick, but not on a flick back up', () => {
    expect(releaseCloses(40, 0.8, 800)).toBe(true);
    expect(releaseCloses(20, 0.8, 800)).toBe(false);
    expect(releaseCloses(300, -0.5, 800)).toBe(false);
    expect(releaseCloses(0, 2, 800)).toBe(false);
  });

  it('measures the speed over the last stretch only', () => {
    expect(releaseSpeed([])).toBe(0);
    expect(
      releaseSpeed([
        { t: 0, y: 0 },
        { t: 500, y: 10 },
        { t: 550, y: 60 },
        { t: 600, y: 110 }
      ])
    ).toBe(1);
  });
});

describe('reader panels', () => {
  it('are sheets below 768 px and close at once on a long swipe', async () => {
    const { readerPanelSwipe, PANEL_SHEET_MEDIA } = await import('./sheet-swipe');
    let closed = 0;
    const options = readerPanelSwipe(() => closed++);
    expect(options.media).toBe(PANEL_SHEET_MEDIA);
    expect(PANEL_SHEET_MEDIA).toBe('(max-width: 767.98px)');
    expect(options.enabled() && options.canClose()).toBe(true);
    options.close();
    expect(closed).toBe(1);
  });
});
