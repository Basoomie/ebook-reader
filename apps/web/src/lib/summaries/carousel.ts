/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Characters carousel (session 4): one card at a time, the arrows on its two ends, a swipe,
 * or a name button. A sideways swipe decides like the picture viewer's (image-lightbox.svelte):
 * the first 8 px choose the direction, 50 px sideways turn the card.
 */

export const SWIPE_PX = 50;
export const SLOP_PX = 8;

/** i in 0..n-1, going round at both ends. */
export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((i % n) + n) % n;
}

/** The direction a drag has taken once past the slop: sideways, up and down, or not yet. */
export function dragAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** A finished sideways drag: +1 the next card (dragged left), -1 the one before, 0 none. */
export function swipeStep(dx: number, axis: 'x' | 'y' | null): -1 | 0 | 1 {
  if (axis !== 'x' || Math.abs(dx) < SWIPE_PX) return 0;
  return dx < 0 ? 1 : -1;
}
