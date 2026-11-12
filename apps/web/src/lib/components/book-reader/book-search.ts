/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';
import { isNodeGaiji } from '$lib/functions/is-node-gaiji';

/**
 * Characters the reader counts, one code point at a time. Must stay the same as
 * `isNotJapaneseRegex` in `lib/functions/get-character-count.ts` (negated); the tests
 * check the two agree on every text node of the fixture books.
 */
const countedChar =
  /^[0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]$/iu;

/** Block elements: text in different ones never matches across them. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL'
]);

/** Ends a sentence for the result line. */
export const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '．', '…']);

/** Shown in place of a gaiji image; never typed, so it never matches. */
const GAIJI_MARK = '〓';

export const BLOCK_BREAK = '\n';

/**
 * WP10c: the text of a book (or of the live page) for searching, with the reader's own
 * character positions. Built from the same nodes the reader counts (`getParagraphNodes`,
 * which skips ruby readings and hidden content), so a match's position is exactly the
 * `exploredCharCount` the reader uses.
 *
 * - `display` holds the text as shown: whitespace runs become one space, block boundaries
 *   become a line break, gaiji become 〓. `<rp>` brackets are left out (they would split
 *   words written with ruby) but still count, as in the reader.
 * - `norm` is what queries are matched against: NFKC, lower case, no whitespace.
 */
export interface BookTextIndex {
  display: string[];
  /** Counted characters before each display character. */
  countBefore: number[];
  /** Live DOM position of each display character (only for indexes of a live page). */
  nodeAt: (Node | null)[];
  offsetAt: number[];
  norm: string;
  /** Display index of each UTF-16 unit of `norm`. */
  normToDisplay: number[];
  /** Counted characters in the whole text. */
  total: number;
}

export interface SearchMatch {
  /** Counted characters before the match: the reader position to jump to. */
  position: number;
  displayStart: number;
  displayEnd: number;
}

export interface SearchResult extends SearchMatch {
  before: string;
  match: string;
  after: string;
}

/** What the search dialog shows; kept while the book is open so it reopens as left. */
export interface SearchState {
  query: string;
  results: SearchResult[];
  more: boolean;
  searched: boolean;
}

/** Normalises text for matching, one code point at a time (keeps the index map exact). */
export function normalizeForSearch(text: string) {
  let out = '';

  for (const ch of Array.from(text)) {
    if (/\s/u.test(ch)) {
      continue;
    }

    out += ch.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  }

  return out;
}

function blockOf(node: Node) {
  let el: Node | null = node.parentNode;

  while (el && !(el.nodeType === 1 && BLOCK_TAGS.has((el as Element).nodeName.toUpperCase()))) {
    el = el.parentNode;
  }

  return el;
}

function insideRp(node: Node) {
  let el: Node | null = node.parentNode;

  while (el) {
    if (el.nodeType === 1 && (el as Element).nodeName.toUpperCase() === 'RP') {
      return true;
    }

    el = el.parentNode;
  }

  return false;
}

export function buildBookTextIndex(root: Node, keepNodes = false): BookTextIndex {
  const display: string[] = [];
  const countBefore: number[] = [];
  const nodeAt: (Node | null)[] = [];
  const offsetAt: number[] = [];
  const normToDisplay: number[] = [];
  let norm = '';
  let count = 0;
  let lastBlock: Node | null | undefined;

  const push = (ch: string, node: Node | null, offset: number) => {
    display.push(ch);
    countBefore.push(count);
    nodeAt.push(keepNodes ? node : null);
    offsetAt.push(offset);
  };

  for (const node of getParagraphNodes(root)) {
    const block = blockOf(node);

    if (lastBlock !== undefined && block !== lastBlock && display.length) {
      if (display[display.length - 1] === ' ') {
        display.pop();
        countBefore.pop();
        nodeAt.pop();
        offsetAt.pop();
      }

      push(BLOCK_BREAK, null, 0);
      norm += '\u0000';
      normToDisplay.push(display.length - 1);
    }

    lastBlock = block;

    if (isNodeGaiji(node)) {
      push(GAIJI_MARK, node, 0);
      norm += '\u0001';
      normToDisplay.push(display.length - 1);
      count += 1;
      continue;
    }

    const text = node.textContent ?? '';
    const hidden = insideRp(node);
    let offset = 0;

    for (const ch of Array.from(text)) {
      const counted = countedChar.test(ch);

      if (hidden) {
        count += counted ? 1 : 0;
      } else if (/\s/u.test(ch)) {
        const last = display[display.length - 1];

        if (display.length && last !== ' ' && last !== BLOCK_BREAK) {
          push(' ', node, offset);
        }
      } else {
        push(ch, node, offset);
        const n = ch.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

        for (let i = 0; i < n.length; i++) {
          normToDisplay.push(display.length - 1);
        }

        norm += n;
        count += counted ? 1 : 0;
      }

      offset += ch.length;
    }
  }

  return { display, countBefore, nodeAt, offsetAt, norm, normToDisplay, total: count };
}

/** Every match of `query` in order, at most `limit`. */
export function findMatches(index: BookTextIndex, query: string, limit = Infinity) {
  const needle = normalizeForSearch(query);
  const matches: SearchMatch[] = [];

  if (!needle) {
    return { matches, more: false };
  }

  let from = 0;

  for (;;) {
    const at = index.norm.indexOf(needle, from);

    if (at < 0) {
      return { matches, more: false };
    }

    if (matches.length >= limit) {
      return { matches, more: true };
    }

    const displayStart = index.normToDisplay[at];
    const displayEnd = index.normToDisplay[at + needle.length - 1] + 1;
    matches.push({ position: index.countBefore[displayStart], displayStart, displayEnd });
    from = at + needle.length;
  }
}

/** The sentence around a match, cut at a sentence end or paragraph, at most `max` each side. */
export function resultLine(index: BookTextIndex, match: SearchMatch, max = 60): SearchResult {
  const { display } = index;
  let start = match.displayStart;

  while (start > 0 && match.displayStart - start < max) {
    const prev = display[start - 1];

    if (prev === BLOCK_BREAK || SENTENCE_END.has(prev)) {
      break;
    }

    start -= 1;
  }

  const cutBefore =
    start > 0 && display[start - 1] !== BLOCK_BREAK && !SENTENCE_END.has(display[start - 1]);

  let end = match.displayEnd;
  let cutAfter = false;

  for (;;) {
    if (end >= display.length || display[end] === BLOCK_BREAK) {
      break;
    }

    if (end - match.displayEnd >= max) {
      cutAfter = true;
      break;
    }

    const ch = display[end];
    end += 1;

    if (SENTENCE_END.has(ch)) {
      // Keep closing brackets that follow the sentence end (」』）).
      while (end < display.length && /^[」』）)】〉》"'”’]$/u.test(display[end])) {
        end += 1;
      }

      break;
    }
  }

  const before = display.slice(start, match.displayStart).join('').trimStart();
  const after = display.slice(match.displayEnd, end).join('').trimEnd();

  return {
    ...match,
    before: (cutBefore ? '…' : '') + before,
    match: display.slice(match.displayStart, match.displayEnd).join(''),
    after: after + (cutAfter ? '…' : '')
  };
}

/** Search a book: results with their sentence, at most `limit`. */
export function searchBook(index: BookTextIndex, query: string, limit = 500) {
  const { matches, more } = findMatches(index, query, limit);

  return { results: matches.map((m) => resultLine(index, m)), more };
}

/** A DOM range for a match of an index built with `keepNodes` (a live page). */
export function matchRange(index: BookTextIndex, match: SearchMatch, doc: Document) {
  const startNode = index.nodeAt[match.displayStart];
  const lastNode = index.nodeAt[match.displayEnd - 1];

  if (!startNode || !lastNode) {
    return undefined;
  }

  const range = doc.createRange();
  range.setStart(startNode, index.offsetAt[match.displayStart]);

  if (isNodeGaiji(lastNode) || lastNode.nodeType !== 3) {
    range.setEndAfter(lastNode);
  } else {
    const lastChar = index.display[match.displayEnd - 1];
    range.setEnd(lastNode, index.offsetAt[match.displayEnd - 1] + lastChar.length);
  }

  return range;
}

/** Parses the reader's HTML into a document that never loads images or runs scripts. */
export function parseBookHtml(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.body;
}
