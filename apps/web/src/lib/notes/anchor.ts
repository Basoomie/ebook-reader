/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookTextIndex } from '$lib/components/book-reader/book-search';

/**
 * WP11a: where a highlight sits in a book, and finding it again.
 *
 * An anchor is the reader's own character positions (`start`, `end`: counted characters
 * before the first and after the last character, like `exploredCharCount`) plus the text
 * as shown and a little context on each side. Positions place it in the copy it was made
 * in; the text and context find it again in a copy that changed (Calibre replaced the
 * EPUB). Finding it again is done per device and never written back: two devices may
 * hold different copies of a book.
 *
 * Texts are compared "loosely": without whitespace and line breaks, so a highlight across
 * two paragraphs, or a copy that differs only in spacing, still matches.
 */
export interface TextAnchor {
  start: number;
  end: number;
  /** The text as shown (`BookTextIndex.display`), paragraphs separated by a line break. */
  text: string;
  /** Up to ANCHOR_CONTEXT characters before and after, as shown. */
  before: string;
  after: string;
}

/** Context kept on each side (the server allows 32). */
export const ANCHOR_CONTEXT = 32;
/** Longest highlight, in characters (the server allows 10,000). */
export const MAX_ANCHOR_TEXT = 10_000;
/** Context that must agree for a far-away occurrence to count as the highlight. */
export const CONTEXT_MATCH_CHARS = 8;
/** At most this many occurrences are looked at when finding a short text again. */
const MAX_OCCURRENCES = 20_000;

/** A place in an index: display indices [displayStart, displayEnd). */
export interface DisplaySpan {
  displayStart: number;
  displayEnd: number;
}

export type Placement =
  | ({ status: 'exact' } & DisplaySpan & { start: number })
  | ({ status: 'moved' } & DisplaySpan & { start: number })
  | { status: 'unplaced' };

interface LooseText {
  /** All display characters without whitespace and line breaks. */
  text: string;
  /** Display index of each UTF-16 unit of `text`. */
  toDisplay: number[];
  /** UTF-16 offset in `text` of each display index (the next one for whitespace). */
  fromDisplay: number[];
}

const looseCache = new WeakMap<BookTextIndex, LooseText>();

function isLooseSkipped(ch: string) {
  return /\s/u.test(ch);
}

export function looseKey(text: string) {
  return Array.from(text)
    .filter((ch) => !isLooseSkipped(ch))
    .join('');
}

function looseTextOf(index: BookTextIndex): LooseText {
  const cached = looseCache.get(index);

  if (cached) {
    return cached;
  }

  let text = '';
  const toDisplay: number[] = [];
  const fromDisplay: number[] = [];

  index.display.forEach((ch, i) => {
    fromDisplay.push(text.length);

    if (isLooseSkipped(ch)) {
      return;
    }

    text += ch;

    for (let u = 0; u < ch.length; u += 1) {
      toDisplay.push(i);
    }
  });

  fromDisplay.push(text.length);
  const loose = { text, toDisplay, fromDisplay };
  looseCache.set(index, loose);
  return loose;
}

/** Counted characters after display index `i` (exclusive end position). */
function countAfter(index: BookTextIndex, displayEnd: number) {
  return displayEnd < index.display.length ? index.countBefore[displayEnd] : index.total;
}

function isBlank(ch: string | undefined) {
  return ch === undefined || /\s/u.test(ch);
}

function contextBefore(index: BookTextIndex, displayStart: number) {
  const from = Math.max(0, displayStart - ANCHOR_CONTEXT);
  return index.display.slice(from, displayStart).join('');
}

function contextAfter(index: BookTextIndex, displayEnd: number) {
  return index.display.slice(displayEnd, displayEnd + ANCHOR_CONTEXT).join('');
}

/** Trims whitespace and paragraph breaks off both ends of a span. */
function trimSpan(index: BookTextIndex, span: DisplaySpan): DisplaySpan {
  let { displayStart, displayEnd } = span;

  while (displayStart < displayEnd && isBlank(index.display[displayStart])) {
    displayStart += 1;
  }

  while (displayEnd > displayStart && isBlank(index.display[displayEnd - 1])) {
    displayEnd -= 1;
  }

  return { displayStart, displayEnd };
}

/** The anchor of a span of an index; `base` = counted characters before the index's root. */
export function anchorOfSpan(
  index: BookTextIndex,
  span: DisplaySpan,
  base = 0
): TextAnchor | undefined {
  const { displayStart, displayEnd } = trimSpan(index, span);

  if (displayEnd <= displayStart) {
    return undefined;
  }

  const start = index.countBefore[displayStart];
  const end = countAfter(index, displayEnd);

  // Only punctuation or spaces: nothing the reader counts, nothing worth keeping.
  if (end <= start) {
    return undefined;
  }

  const text = index.display.slice(displayStart, displayEnd).join('');

  if (Array.from(text).length > MAX_ANCHOR_TEXT) {
    return undefined;
  }

  return {
    start: base + start,
    end: base + end,
    text,
    before: contextBefore(index, displayStart),
    after: contextAfter(index, displayEnd)
  };
}

/** The DOM point where display character `i` starts (gaiji images: before the element). */
function charPoint(index: BookTextIndex, i: number): [Node, number] | undefined {
  const node = index.nodeAt[i];

  if (!node) {
    return undefined;
  }

  if (node.nodeType === 3) {
    return [node, index.offsetAt[i]];
  }

  const parent = node.parentNode;

  if (!parent) {
    return undefined;
  }

  return [parent, Array.prototype.indexOf.call(parent.childNodes, node)];
}

/**
 * A collapsed range at a boundary point. A point inside an element without children
 * (a gaiji image) moves before it for a start and after it for an end, so the image
 * counts as selected.
 */
function pointRange(doc: Document, container: Node, offset: number, side: 'before' | 'after') {
  const point = doc.createRange();

  if (container.nodeType === 1 && !container.hasChildNodes() && container.parentNode) {
    if (side === 'before') {
      point.setStartBefore(container);
    } else {
      point.setStartAfter(container);
    }
  } else {
    point.setStart(container, offset);
  }

  return point;
}

/** Display indices that sit on a live node, in document order. */
function liveIndices(index: BookTextIndex) {
  const out: number[] = [];

  index.nodeAt.forEach((node, i) => {
    if (node) {
      out.push(i);
    }
  });

  return out;
}

/** -1: the character starts before the point, 0: at it, 1: after it. */
function compareToPoint(index: BookTextIndex, i: number, point: Range): number | undefined {
  const at = charPoint(index, i);

  if (!at) {
    return undefined;
  }

  try {
    return point.comparePoint(at[0], at[1]);
  } catch {
    return undefined;
  }
}

/**
 * The span of display characters inside a DOM range, for an index built from a live
 * page (`buildBookTextIndex(root, true)`). Ruby readings are not indexed, so a range
 * ending inside one ends before it.
 */
export function spanOfRange(index: BookTextIndex, range: Range): DisplaySpan | undefined {
  const live = liveIndices(index);
  const doc = range.startContainer.ownerDocument;

  if (!live.length || !doc) {
    return undefined;
  }

  const startPoint = pointRange(doc, range.startContainer, range.startOffset, 'before');
  const endPoint = pointRange(doc, range.endContainer, range.endOffset, 'after');

  // First character starting at or after the range start.
  let lo = 0;
  let hi = live.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareToPoint(index, live[mid], startPoint);

    if (cmp === undefined) {
      return undefined;
    }

    if (cmp < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const first = lo;

  // First character starting at or after the range end: the span ends before it.
  lo = first;
  hi = live.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareToPoint(index, live[mid], endPoint);

    if (cmp === undefined) {
      return undefined;
    }

    if (cmp < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo <= first) {
    return undefined;
  }

  return { displayStart: live[first], displayEnd: live[lo - 1] + 1 };
}

/** The anchor of a DOM range on a live page whose index starts at `base` characters. */
export function anchorOfRange(index: BookTextIndex, range: Range, base = 0) {
  const span = spanOfRange(index, range);
  return span ? anchorOfSpan(index, span, base) : undefined;
}

function firstAtOrAfter(index: BookTextIndex, count: number) {
  let lo = 0;
  let hi = index.countBefore.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (index.countBefore[mid] < count) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

function spanOfLooseMatch(loose: LooseText, at: number, keyLength: number): DisplaySpan {
  return {
    displayStart: loose.toDisplay[at],
    displayEnd: loose.toDisplay[at + keyLength - 1] + 1
  };
}

/**
 * The anchor at its own position in an index whose root starts at `base` characters:
 * a character whose position is `start` and where the text follows. Used to paint a
 * live page, and as the first check in a whole book.
 */
export function locateExact(
  index: BookTextIndex,
  anchor: Pick<TextAnchor, 'start' | 'text'>,
  base = 0
): DisplaySpan | undefined {
  const key = looseKey(anchor.text);
  const target = anchor.start - base;

  if (!key || target < 0) {
    return undefined;
  }

  const loose = looseTextOf(index);

  for (
    let i = firstAtOrAfter(index, target);
    i < index.display.length && index.countBefore[i] === target;
    i += 1
  ) {
    if (isLooseSkipped(index.display[i])) {
      continue;
    }

    const at = loose.fromDisplay[i];

    if (loose.text.startsWith(key, at)) {
      return spanOfLooseMatch(loose, at, key.length);
    }
  }

  return undefined;
}

function commonSuffix(a: string, b: string) {
  let n = 0;

  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n += 1;
  }

  return n;
}

function commonPrefix(a: string, b: string) {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1;
  }

  return n;
}

/** Whether the context around an occurrence agrees with the anchor's. */
function contextAgrees(
  loose: LooseText,
  at: number,
  keyLength: number,
  before: string,
  after: string
) {
  const needed = (stored: string) => Math.min(CONTEXT_MATCH_CHARS, stored.length);

  if (before) {
    const around = loose.text.slice(Math.max(0, at - before.length), at);

    if (commonSuffix(around, before) >= needed(before)) {
      return true;
    }
  }

  if (after) {
    const around = loose.text.slice(at + keyLength, at + keyLength + after.length);

    if (commonPrefix(around, after) >= needed(after)) {
      return true;
    }
  }

  return false;
}

/**
 * Places an anchor in a whole book's index: at its own position when the text is still
 * there, else the nearest occurrence of the text whose context agrees, else the nearest
 * occurrence within `maxDistance` characters, else unplaced (the highlight is kept).
 */
export function placeAnchor(
  index: BookTextIndex,
  anchor: TextAnchor,
  maxDistance: number
): Placement {
  const exact = locateExact(index, anchor);

  if (exact) {
    return { status: 'exact', ...exact, start: index.countBefore[exact.displayStart] };
  }

  const key = looseKey(anchor.text);

  if (!key) {
    return { status: 'unplaced' };
  }

  const loose = looseTextOf(index);
  const before = looseKey(anchor.before);
  const after = looseKey(anchor.after);
  let bestContext: { span: DisplaySpan; distance: number } | undefined;
  let bestNear: { span: DisplaySpan; distance: number } | undefined;
  let seen = 0;

  for (
    let at = loose.text.indexOf(key);
    at >= 0 && seen < MAX_OCCURRENCES;
    at = loose.text.indexOf(key, at + 1), seen += 1
  ) {
    const span = spanOfLooseMatch(loose, at, key.length);
    const distance = Math.abs(index.countBefore[span.displayStart] - anchor.start);

    if (
      contextAgrees(loose, at, key.length, before, after) &&
      (!bestContext || distance < bestContext.distance)
    ) {
      bestContext = { span, distance };
    }

    if (distance <= maxDistance && (!bestNear || distance < bestNear.distance)) {
      bestNear = { span, distance };
    }
  }

  const best = bestContext ?? bestNear;

  if (!best) {
    return { status: 'unplaced' };
  }

  return { status: 'moved', ...best.span, start: index.countBefore[best.span.displayStart] };
}
