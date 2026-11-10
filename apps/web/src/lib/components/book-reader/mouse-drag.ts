/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * Whether the point is on a character of text (not blank space next to it). Browsers snap
 * a text selection to the nearest text, so a drag that starts on blank space would still
 * select something; the reader blocks that selection for drags that start off text.
 */
export function isPointOverText(doc: Document, x: number, y: number, tolerance = 2) {
  const caretDoc = doc as CaretDocument;
  let node: Node | null = null;
  let offset = 0;

  if (caretDoc.caretPositionFromPoint) {
    const position = caretDoc.caretPositionFromPoint(x, y);
    node = position?.offsetNode ?? null;
    offset = position?.offset ?? 0;
  } else if (caretDoc.caretRangeFromPoint) {
    const range = caretDoc.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  } else {
    // Unknown engine: behave as before (the drag may select text).
    return true;
  }

  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return false;
  }

  const length = node.textContent?.length ?? 0;
  const range = doc.createRange();

  for (const index of [offset - 1, offset]) {
    if (index < 0 || index >= length) {
      continue;
    }

    range.setStart(node, index);
    range.setEnd(node, index + 1);

    for (const rect of Array.from(range.getClientRects())) {
      if (
        x >= rect.left - tolerance &&
        x <= rect.right + tolerance &&
        y >= rect.top - tolerance &&
        y <= rect.bottom + tolerance
      ) {
        return true;
      }
    }
  }

  return false;
}

/** svelte-gestures' default `swipe` timeframe, used by the paginated reader (ms). */
export const SWIPE_TIMEFRAME_MS = 500;

export interface MouseDragInput {
  dx: number;
  dy: number;
  durationMs: number;
  /** The drag left no text selected. */
  selectionCollapsed: boolean;
  /** `mouseDragThreshold` setting (px). */
  threshold: number;
  /** Paginated mode, where svelte-gestures' `swipe` already turns pages on quick flicks. */
  paginated: boolean;
  /** `swipeThreshold` setting (px), svelte-gestures' `minSwipeDistance`. */
  swipeThreshold: number;
  verticalMode: boolean;
}

/** Same test as svelte-gestures' `swipe` (horizontal at least twice the vertical movement). */
function isHorizontal(dx: number, dy: number, minDistance: number) {
  const absX = Math.abs(dx);
  return absX >= 2 * Math.abs(dy) && absX > minDistance;
}

/**
 * WP10a: what a finished left-button mouse drag over the book does.
 *
 * - A quick flick in paginated mode is left to the existing `swipe` (it turns the page as
 *   before, even when text got selected), so one drag never turns two pages.
 * - Otherwise a drag turns the page when it moved at least `threshold` px sideways (at least
 *   twice its vertical movement) and selected no text. Drags that selected text keep the
 *   selection and do nothing else.
 * - Direction follows the swipe rule: dragging left is the next page in horizontal text and
 *   the previous page in vertical text.
 */
export function decideMouseDrag(input: MouseDragInput): 'next' | 'prev' | null {
  const { dx, dy } = input;

  if (
    input.paginated &&
    input.durationMs < SWIPE_TIMEFRAME_MS &&
    isHorizontal(dx, dy, input.swipeThreshold)
  ) {
    return null;
  }

  if (!input.selectionCollapsed) {
    return null;
  }

  const threshold = Math.max(1, input.threshold);

  if (Math.abs(dx) < threshold || !isHorizontal(dx, dy, 0)) {
    return null;
  }

  const dragLeft = dx < 0;
  const next = input.verticalMode ? !dragLeft : dragLeft;

  return next ? 'next' : 'prev';
}
