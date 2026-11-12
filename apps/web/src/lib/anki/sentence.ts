/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  BLOCK_BREAK,
  SENTENCE_END,
  type BookTextIndex
} from '$lib/components/book-reader/book-search';

/**
 * WP14: the sentence around a looked-up word, from the reader's text index (ruby
 * readings left out, gaiji as 〓). Boundaries as in-book search uses them: a sentence end
 * (。！？!?．…) or a paragraph break; closing brackets right after the end stay with the
 * sentence. A bracket left unmatched at either edge is dropped (a sentence in the middle
 * of dialogue), so quotes stay balanced. At most MAX_SIDE characters each side.
 */

export const MAX_SIDE = 200;

const CLOSERS = /^[」』）)】〉》"'”’]$/u;
const PAIRS: Record<string, string> = {
  '「': '」',
  '『': '』',
  '（': '）',
  '(': ')',
  '【': '】',
  '〈': '〉',
  '《': '》',
  '“': '”',
  '‘': '’'
};
const OPENERS = new Set(Object.keys(PAIRS));
const CLOSER_OF = new Set(Object.values(PAIRS));

export interface Sentence {
  /** Plain text as shown. */
  text: string;
  /** HTML-escaped, the looked-up word in <b> when known. */
  html: string;
  /** Absolute reader position of the sentence's first character. */
  position: number;
  /** Display characters [start, end) of the index it came from (sentenceAt only). */
  display?: { start: number; end: number };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isEnd(ch: string | undefined) {
  return ch === BLOCK_BREAK || (ch !== undefined && SENTENCE_END.has(ch));
}

/**
 * The sentence containing display characters [wordStart, wordEnd) of `index`, whose
 * first character is at `base` (the section start in paginated mode). `boldWord` wraps
 * those characters in <b> (only when the word's length is known, e.g. Yomitan selected it).
 */
export function sentenceAt(
  index: BookTextIndex,
  wordStart: number,
  wordEnd = wordStart + 1,
  { base = 0, boldWord = false }: { base?: number; boldWord?: boolean } = {}
): Sentence | null {
  const { display } = index;

  if (!display.length) {
    return null;
  }

  const at = Math.max(0, Math.min(wordStart, display.length - 1));
  const to = Math.max(at + 1, Math.min(wordEnd, display.length));

  let start = at;

  while (start > 0 && at - start < MAX_SIDE) {
    const prev = display[start - 1];

    if (isEnd(prev)) {
      break;
    }

    // 「…。」 then the next sentence: the closer belongs to the sentence before.
    if (CLOSERS.test(prev) && start >= 2 && isEnd(display[start - 2])) {
      break;
    }

    start -= 1;
  }

  let end = to;

  while (end < display.length && end - to < MAX_SIDE) {
    const ch = display[end];

    if (ch === BLOCK_BREAK) {
      break;
    }

    end += 1;

    if (SENTENCE_END.has(ch)) {
      // Keep more sentence ends (！？, ……) and the closing brackets after them.
      while (end < display.length && SENTENCE_END.has(display[end])) {
        end += 1;
      }

      while (end < display.length && CLOSERS.test(display[end])) {
        end += 1;
      }

      break;
    }
  }

  // Balance brackets at the edges.
  let s = start;
  let e = end;

  for (;;) {
    while (s < at && /\s/u.test(display[s])) s += 1;
    while (e > to && /\s/u.test(display[e - 1])) e -= 1;

    const opened: string[] = [];
    let unmatchedClose = -1;

    for (let i = s; i < e; i += 1) {
      const ch = display[i];

      if (OPENERS.has(ch)) {
        opened.push(ch);
      } else if (CLOSER_OF.has(ch)) {
        if (opened.length && PAIRS[opened[opened.length - 1]] === ch) {
          opened.pop();
        } else if (unmatchedClose < 0) {
          unmatchedClose = i;
        }
      }
    }

    if (unmatchedClose === e - 1 && e - 1 >= to) {
      e -= 1;
      continue;
    }

    if (opened.length && OPENERS.has(display[s]) && s < at) {
      s += 1;
      continue;
    }

    break;
  }

  const text = display.slice(s, e).join('');

  if (!text.trim()) {
    return null;
  }

  const html =
    boldWord && to > at && at >= s && to <= e
      ? `${escapeHtml(display.slice(s, at).join(''))}<b>${escapeHtml(
          display.slice(at, to).join('')
        )}</b>${escapeHtml(display.slice(to, e).join(''))}`
      : escapeHtml(text);

  return {
    text,
    html: html.replace(/\n/g, '<br>'),
    position: base + (index.countBefore[s] ?? 0),
    display: { start: s, end: e }
  };
}

/** A sentence from plain text (the current selection when there was no lookup). */
export function sentenceFromText(text: string, position: number): Sentence | null {
  const clean = text.replace(/\s*\n\s*/g, '\n').trim();

  if (!clean) {
    return null;
  }

  return { text: clean, html: escapeHtml(clean).replace(/\n/g, '<br>'), position };
}
