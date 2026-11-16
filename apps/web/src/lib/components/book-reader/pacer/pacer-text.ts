/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';
import { blockOf, isCountedChar } from '$lib/components/book-reader/book-search';
import { getCharacterCount } from '$lib/functions/get-character-count';
import { isNodeGaiji } from '$lib/functions/is-node-gaiji';

/**
 * Season 2 pacer: the text of the reader's page, with the reader's own counting.
 *
 * The nodes are the reader's (`getParagraphNodes`: text nodes and gaiji images, ruby
 * readings left out) and their counts are the reader's (`getCharacterCount`), so a pacer
 * position is the same number as the reader's `exploredCharCount`. Characters are listed
 * only for a slice of nodes (the part on and next to the screen): a whole book in
 * continuous mode never gets a per-character list.
 */

/** One character of the page (a code point, or one gaiji image). */
export interface PacerChar {
  node: Node;
  /** UTF-16 offset in the text node (0 for a gaiji image). */
  offset: number;
  /** UTF-16 length (1 for a gaiji image). */
  len: number;
  gaiji: boolean;
  counted: boolean;
  /**
   * The character's reading time, in absolute counted characters: it is read while the
   * pacer's point is in [start, end). A counted character takes one; an uncounted one (a
   * bracket, punctuation, a space) shares the time of the counted character before it in
   * its paragraph, or takes none at the start of a paragraph.
   */
  start: number;
  end: number;
  /** The block element (paragraph, heading, …) it belongs to. */
  block: Node | null;
}

export class PacerText {
  readonly nodes: Node[];

  /** Counted characters before each node (relative to the root). */
  readonly before: number[];

  readonly total: number;

  constructor(readonly root: Node) {
    this.nodes = getParagraphNodes(root);
    this.before = new Array(this.nodes.length);
    let count = 0;

    for (let i = 0; i < this.nodes.length; i++) {
      this.before[i] = count;
      count += getCharacterCount(this.nodes[i]);
    }

    this.total = count;
  }

  /**
   * The characters of nodes [from, to), with absolute times (`base` = counted characters
   * before the root: the paginated reader's section start, 0 in continuous mode).
   */
  chars(from: number, to: number, base: number): PacerChar[] {
    const out: PacerChar[] = [];
    let lastCounted: PacerChar | undefined;
    const end = Math.min(to, this.nodes.length);

    for (let i = Math.max(0, from); i < end; i++) {
      const node = this.nodes[i];
      const block = blockOf(node);
      let count = base + this.before[i];

      if (lastCounted && lastCounted.block !== block) {
        lastCounted = undefined;
      }

      if (isNodeGaiji(node)) {
        lastCounted = {
          node,
          offset: 0,
          len: 1,
          gaiji: true,
          counted: true,
          start: count,
          end: count + 1,
          block
        };
        out.push(lastCounted);
        continue;
      }

      const text = node.textContent ?? '';
      let offset = 0;

      for (const ch of Array.from(text)) {
        if (isCountedChar(ch)) {
          lastCounted = {
            node,
            offset,
            len: ch.length,
            gaiji: false,
            counted: true,
            start: count,
            end: count + 1,
            block
          };
          out.push(lastCounted);
          count += 1;
        } else {
          out.push({
            node,
            offset,
            len: ch.length,
            gaiji: false,
            counted: false,
            start: lastCounted ? lastCounted.start : count,
            end: lastCounted ? lastCounted.end : count,
            block
          });
        }

        offset += ch.length;
      }
    }

    return out;
  }

  /** Index of the node holding relative count `count` (the last node starting at or before it). */
  nodeAtCount(count: number) {
    let lo = 0;
    let hi = this.nodes.length - 1;

    if (hi < 0) {
      return -1;
    }

    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;

      if (this.before[mid] <= count) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return lo;
  }
}

/**
 * A DOM range over characters [from, to) of a list. When `to` is inside the list the range
 * ends where the next character starts, so a ruby reading between the two (its `rt`, which
 * has no characters in the list) goes with the text before it.
 */
export function charsRange(chars: PacerChar[], from: number, to: number, doc: Document) {
  if (from >= to || from < 0 || to > chars.length) {
    return undefined;
  }

  const first = chars[from];
  const range = doc.createRange();

  if (first.gaiji) {
    range.setStartBefore(first.node);
  } else {
    range.setStart(first.node, first.offset);
  }

  const next = chars[to];

  if (next) {
    if (next.gaiji) {
      range.setEndBefore(next.node);
    } else {
      range.setEnd(next.node, next.offset);
    }
  } else {
    const last = chars[to - 1];

    if (last.gaiji) {
      range.setEndAfter(last.node);
    } else {
      range.setEnd(last.node, last.offset + last.len);
    }
  }

  return range;
}
