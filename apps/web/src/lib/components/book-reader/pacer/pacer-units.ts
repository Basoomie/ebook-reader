/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { CLOSING_BRACKET, SENTENCE_END } from '$lib/components/book-reader/book-search';

/**
 * Season 2 pacer: the units it moves by. Each function gives every character a unit
 * number, rising in reading order. Paragraphs: block elements. Sentences: up to a sentence
 * end (。！？!?．…) and the closing brackets after it, or the paragraph's end. Lines: from
 * the characters' measured positions (E-ink steps by line).
 */

export interface UnitChar {
  ch?: string;
  block: unknown;
}

/** Unit numbers by paragraph (block element). */
export function paragraphUnits(chars: UnitChar[]): number[] {
  const units = new Array<number>(chars.length);
  let unit = 0;

  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && chars[i].block !== chars[i - 1].block) {
      unit += 1;
    }

    units[i] = unit;
  }

  return units;
}

/** Unit numbers by sentence; `text(i)` is character i. */
export function sentenceUnits(chars: UnitChar[], text: (i: number) => string): number[] {
  const units = new Array<number>(chars.length);
  let unit = 0;
  let ended = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = text(i);

    if (i > 0 && chars[i].block !== chars[i - 1].block) {
      unit += 1;
      ended = false;
    } else if (ended && !CLOSING_BRACKET.test(ch) && !SENTENCE_END.has(ch)) {
      unit += 1;
      ended = false;
    }

    units[i] = unit;

    if (SENTENCE_END.has(ch)) {
      ended = true;
    }
  }

  return units;
}

/**
 * Where a character sits across the lines: its centre on the block axis (x in vertical
 * text, y in horizontal text) and its size on that axis; null when it has no box (a
 * collapsed space).
 */
export interface LineBox {
  center: number;
  size: number;
}

/**
 * Unit numbers by line: a new line starts where a character's centre on the block axis
 * moves by more than half a character from the line's, or at a new paragraph. A
 * character without a box stays on the line before it.
 */
export function lineUnits(chars: UnitChar[], boxes: (LineBox | null)[]): number[] {
  const units = new Array<number>(chars.length);
  let unit = 0;
  let line: LineBox | null = null;

  for (let i = 0; i < chars.length; i++) {
    const box = boxes[i];

    if (i > 0 && chars[i].block !== chars[i - 1].block) {
      unit += 1;
      line = null;
    }

    if (box) {
      if (!line) {
        line = box;
      } else if (Math.abs(box.center - line.center) > Math.max(line.size, box.size) / 2) {
        unit += 1;
        line = box;
      }
    }

    units[i] = unit;
  }

  return units;
}
