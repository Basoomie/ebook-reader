/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP17: the text a generated audiobook reads, from the reader's own import of the EPUB
 * (the same chapters, text and character positions as the reader).
 *
 * - Chapters: the reader's main chapters (its sections without a parent chapter); a spine
 *   item without a TOC entry joins the chapter before it, as in the reader. A book without
 *   a TOC is one chapter. Chapters without text are left out.
 * - Sentences: the reader's text index (`buildBookTextIndex`: ruby readings and hidden
 *   content left out, gaiji as 〓), split where in-book search ends a sentence (。！？!?．…
 *   plus closing brackets right after) and at every block (paragraph) break. Sentences
 *   longer than `maxSentence` are split after a 、 (or hard at the limit), so one model
 *   call stays well under the TTS model's text limit.
 * - `text` is the sentence as shown (it becomes the subtitle line, so whispersync's match
 *   finds it in the book); `reading` is the same with every ruby base replaced by its
 *   furigana and gaiji left out (it is what the PC converts to kana and reads aloud).
 * - `position` is the reader position (counted characters before the sentence).
 */

import {
  BLOCK_BREAK,
  buildBookTextIndex,
  SENTENCE_END
} from '$lib/components/book-reader/book-search';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';

export const BOOK_SCRIPT_VERSION = 1;
export const DEFAULT_MAX_SENTENCE = 120;

export interface ScriptSentence {
  text: string;
  reading: string;
  position: number;
  /** The last sentence of its paragraph (a longer pause follows). */
  paragraphEnd: boolean;
}

export interface ScriptChapter {
  /** 0-based among the chapters kept. */
  index: number;
  title: string;
  /** Reader position of the chapter's first counted character. */
  startCharacter: number;
  /** Counted characters in the chapter. */
  characters: number;
  sentences: ScriptSentence[];
}

export interface BookScript {
  version: number;
  /** Counted characters of the whole book (the reader's `characters`). */
  characters: number;
  chapters: ScriptChapter[];
}

const CLOSERS = /^[」』）)】〉》"'”’]$/u;
const PAUSE_AFTER = new Set(['、', '，', ',', '　', ' ']);
const GAIJI_MARK = '〓';
/** Something to say: a letter or a digit (not only punctuation, symbols or gaiji). */
const SPEAKABLE = /[\p{L}\p{N}]/u;

function rubyOf(node: Node | null, stop: Node): Element | null {
  let el: Node | null = node?.parentNode ?? null;

  while (el && el !== stop) {
    if (el.nodeType === 1 && (el as Element).nodeName.toUpperCase() === 'RUBY') {
      return el as Element;
    }

    el = el.parentNode;
  }

  return null;
}

function rubyReading(ruby: Element): string {
  return Array.from(ruby.querySelectorAll('rt'))
    .map((rt) => rt.textContent ?? '')
    .join('')
    .replace(/\s+/gu, '');
}

interface Range {
  start: number;
  end: number;
  paragraphEnd: boolean;
}

/** Splits [start, end) into pieces of at most `max` display characters, after a 、 if possible. */
function splitLong(range: Range, display: string[], max: number): Range[] {
  const out: Range[] = [];
  let a = range.start;

  while (range.end - a > max) {
    let cut = -1;

    for (let k = a + max - 1; k > a + Math.floor(max / 3); k--) {
      if (PAUSE_AFTER.has(display[k])) {
        cut = k + 1;
        break;
      }
    }

    if (cut < 0) {
      cut = a + max;
    }

    out.push({ start: a, end: cut, paragraphEnd: false });
    a = cut;
  }

  out.push({ start: a, end: range.end, paragraphEnd: range.paragraphEnd });

  return out;
}

/** Sentence ranges of one text index's display characters. */
function sentenceRanges(display: string[]): Range[] {
  const out: Range[] = [];
  let start = 0;
  let i = 0;

  while (i < display.length) {
    const ch = display[i];

    if (ch === BLOCK_BREAK) {
      out.push({ start, end: i, paragraphEnd: true });
      start = i + 1;
      i += 1;
      continue;
    }

    if (SENTENCE_END.has(ch)) {
      let j = i + 1;

      while (j < display.length && SENTENCE_END.has(display[j])) j += 1;
      while (j < display.length && CLOSERS.test(display[j])) j += 1;

      out.push({
        start,
        end: j,
        paragraphEnd: j >= display.length || display[j] === BLOCK_BREAK
      });

      if (j < display.length && display[j] === BLOCK_BREAK) j += 1;

      start = j;
      i = j;
      continue;
    }

    i += 1;
  }

  out.push({ start, end: display.length, paragraphEnd: true });

  return out;
}

/** The script of one spine item's element, positions offset by `offset`. */
function elementSentences(
  element: Element,
  offset: number,
  maxSentence: number
): { sentences: ScriptSentence[]; total: number } {
  const index = buildBookTextIndex(element, true);
  const { display, countBefore, nodeAt } = index;
  const sentences: ScriptSentence[] = [];

  for (const sentence of sentenceRanges(display)) {
    for (const range of splitLong(sentence, display, maxSentence)) {
      let a = range.start;
      let b = range.end;

      while (a < b && /\s/u.test(display[a])) a += 1;
      while (b > a && /\s/u.test(display[b - 1])) b -= 1;

      if (a >= b) continue;

      const text = display.slice(a, b).join('');

      if (!SPEAKABLE.test(text.replace(new RegExp(GAIJI_MARK, 'gu'), ''))) {
        // Nothing to say (e.g. ＊＊＊). Still ends a paragraph for the pause before.
        if (range.paragraphEnd && sentences.length) {
          sentences[sentences.length - 1].paragraphEnd = true;
        }
        continue;
      }

      let reading = '';
      let lastRuby: Element | null = null;

      for (let k = a; k < b; k++) {
        const ch = display[k];

        if (ch === GAIJI_MARK) {
          lastRuby = null;
          continue;
        }

        const ruby = rubyOf(nodeAt[k], element);
        const rt = ruby ? rubyReading(ruby) : '';

        if (ruby && rt) {
          if (ruby !== lastRuby) reading += rt;
          lastRuby = ruby;
        } else {
          reading += ch;
          lastRuby = null;
        }
      }

      sentences.push({
        text,
        reading,
        position: offset + countBefore[a],
        paragraphEnd: range.paragraphEnd
      });
    }
  }

  return { sentences, total: index.total };
}

/**
 * The script of an imported book: `elementHtml` and `sections` as the reader's import
 * stores them, parsed with `document` (a browser document, or jsdom on the server).
 */
export function bookScriptFromHtml(
  elementHtml: string,
  sections: Section[],
  characters: number,
  document: Document,
  { maxSentence = DEFAULT_MAX_SENTENCE }: { maxSentence?: number } = {}
): BookScript {
  const container = document.createElement('div');

  container.innerHTML = elementHtml;

  const sectionOf = new Map(sections.map((s) => [s.reference, s]));
  const chapters: { title: string; parts: Element[] }[] = [];

  for (const child of Array.from(container.children)) {
    const section = sectionOf.get(child.id);

    if (!chapters.length || (section && !section.parentChapter)) {
      chapters.push({ title: section?.label?.trim() ?? '', parts: [child] });
    } else {
      chapters[chapters.length - 1].parts.push(child);
    }
  }

  const out: ScriptChapter[] = [];
  let offset = 0;

  for (const chapter of chapters) {
    const startCharacter = offset;
    const sentences: ScriptSentence[] = [];

    for (const part of chapter.parts) {
      const result = elementSentences(part, offset, maxSentence);

      sentences.push(...result.sentences);
      offset += result.total;
    }

    if (!sentences.length) continue;

    out.push({
      index: out.length,
      title: chapter.title || `Chapter ${out.length + 1}`,
      startCharacter,
      characters: offset - startCharacter,
      sentences
    });
  }

  return { version: BOOK_SCRIPT_VERSION, characters, chapters: out };
}
