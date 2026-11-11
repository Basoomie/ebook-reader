/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Cover size (WP19a, per device `libraryCoverSize`): the width of a cover in the grids.
 * 0 = automatic, the columns by screen width the grids had before (3 on a phone, 8 on a
 * wide screen). Any other value fills the row with covers of about that width, but a
 * phone always keeps at least two per row.
 */

export const COVER_SIZE_MIN = 90;
export const COVER_SIZE_MAX = 260;
export const COVER_SIZE_STEP = 10;
/** Where the slider starts when the size is still automatic. */
export const COVER_SIZE_START = 140;

/** The automatic grid (Tailwind classes), as before WP19a. */
export const AUTO_GRID_CLASSES =
  'grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8';

/** A stored value as a size: 0 (automatic) or a width within the limits. */
export function coverSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const stepped = Math.round(n / COVER_SIZE_STEP) * COVER_SIZE_STEP;
  return Math.min(COVER_SIZE_MAX, Math.max(COVER_SIZE_MIN, stepped));
}

/** Classes and inline style of a cover grid for a size. */
export function coverGrid(size: number): { classes: string; style: string } {
  const px = coverSize(size);
  if (!px) return { classes: AUTO_GRID_CLASSES, style: '' };
  // min(): never more than half the row, so a phone keeps two covers per row.
  return {
    classes: 'grid gap-x-3 gap-y-4',
    style: `grid-template-columns: repeat(auto-fill, minmax(min(${px}px, calc(50% - 0.375rem)), 1fr))`
  };
}
