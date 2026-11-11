/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { AUTO_GRID_CLASSES, coverGrid, coverSize } from './cover-size';

describe('cover size', () => {
  it('keeps 0 as automatic and clamps other values to the slider', () => {
    expect(coverSize(0)).toBe(0);
    expect(coverSize(-5)).toBe(0);
    expect(coverSize('abc')).toBe(0);
    expect(coverSize(10)).toBe(90);
    expect(coverSize(144)).toBe(140);
    expect(coverSize(5000)).toBe(260);
  });

  it('uses the old responsive columns when automatic, else covers of about the size', () => {
    expect(coverGrid(0)).toEqual({ classes: AUTO_GRID_CLASSES, style: '' });
    const grid = coverGrid(180);
    expect(grid.classes).toBe('grid gap-x-3 gap-y-4');
    expect(grid.style).toContain('minmax(min(180px, calc(50% - 0.375rem)), 1fr)');
  });
});
