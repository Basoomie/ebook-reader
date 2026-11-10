/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Multi-select helpers for the library (WP7a): Shift+click ranges and mouse box drags. */

/** The ids from `from` to `to` (inclusive, either direction) in list order. */
export function rangeIds(ids: readonly string[], from: string, to: string): string[] {
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a === -1 || b === -1) return b === -1 ? [] : [to];
  const [start, end] = a <= b ? [a, b] : [b, a];
  return ids.slice(start, end + 1);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box spanned by two points. */
export function boxFrom(x1: number, y1: number, x2: number, y2: number): Box {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2)
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** A pointer movement this small is a click, not a drag (px). */
export const DRAG_THRESHOLD = 6;

/** Toggles one id in a selection (a new Set: the app compiles Svelte as immutable). */
export function toggled(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function withAll(selection: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(selection);
  ids.forEach((id) => next.add(id));
  return next;
}
