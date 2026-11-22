/**
 * Book summaries (session 2): a book's text as the models read it, and where a quote is in it.
 *
 * The text comes from the reader's own import (the book script, `readBookScript`), so chapters
 * are the reader's chapters and every position is a reader position (the number of counted
 * characters before it, as `/open?book=…&pos=…` takes it). The display text is used (ruby base
 * only, no furigana), so a model's quote can match it.
 *
 * A quote counts only when it is found whole and contiguous in this book's text after the
 * never-invent normalization (`evidenceForm`: NFKC, lower case, spaces and punctuation ignored).
 * That is stricter than the cleanup's `inEvidence` (which accepts parts found separately): a
 * quote is the evidence of a claim, so its words must stand together in the book.
 */
import { evidenceForm } from '../ai/evidence-check';
import type { BookScript } from '../audio/book-script';

/**
 * Characters the reader counts, one code point at a time: the same expression as the web
 * app's `isCountedChar` (`lib/components/book-reader/book-search.ts`). The tests check it
 * against the book script's own positions (each sentence starts where the one before ends).
 */
const COUNTED =
  /^[0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]$/iu;

export function isCountedChar(ch: string): boolean {
  return COUNTED.test(ch);
}

export interface TextChapter {
  /** 0-based, the reader's chapter order. */
  index: number;
  title: string;
  /** Reader position of the chapter's first counted character. */
  start: number;
  /** Counted characters in the chapter. */
  characters: number;
  /** The chapter's display text, paragraphs on their own lines. */
  text: string;
}

export interface BookText {
  characters: number;
  chapters: TextChapter[];
}

export interface QuoteHit {
  position: number;
  chapter: number;
}

/** Shortest quote (in the comparison form) that counts as evidence. */
export const MIN_QUOTE_CHARS = 6;

export function bookTextFromScript(script: BookScript): BookText {
  const chapters: TextChapter[] = script.chapters.map((c, i) => {
    let text = '';
    for (const s of c.sentences) {
      text += s.text;
      if (s.paragraphEnd) text += '\n';
    }
    return {
      index: i,
      title: c.title,
      start: c.startCharacter,
      characters: c.characters,
      text: text.trim(),
    };
  });
  return { characters: script.characters, chapters };
}

/**
 * The book in the comparison form with each form character's reader position and chapter.
 * Built once per book.
 */
export class QuoteIndex {
  private readonly form: string;
  private readonly pos: Int32Array;
  private readonly chap: Int16Array;

  constructor(script: BookScript) {
    const parts: string[] = [];
    const pos: number[] = [];
    const chap: number[] = [];
    script.chapters.forEach((c, ci) => {
      for (const s of c.sentences) {
        let counted = 0;
        for (const ch of s.text) {
          const f = evidenceForm(ch);
          for (let k = 0; k < f.length; k++) {
            pos.push(s.position + counted);
            chap.push(ci);
          }
          if (f) parts.push(f);
          if (isCountedChar(ch)) counted++;
        }
      }
    });
    this.form = parts.join('');
    this.pos = Int32Array.from(pos);
    this.chap = Int16Array.from(chap);
  }

  /**
   * Where the quote is (its first character), or null when it isn't in the book whole. With
   * several places, the first one in `preferChapter` (the chapter the model gave), else the first.
   */
  find(quote: string, preferChapter?: number): QuoteHit | null {
    const q = evidenceForm(quote);
    if (q.length < MIN_QUOTE_CHARS) return null;
    let first: QuoteHit | null = null;
    for (let at = this.form.indexOf(q); at >= 0; at = this.form.indexOf(q, at + 1)) {
      const hit = { position: this.pos[at], chapter: this.chap[at] };
      if (preferChapter === undefined || hit.chapter === preferChapter) return hit;
      first ??= hit;
    }
    return first;
  }

  /** Whether a name (any length) is written in the book. */
  hasName(name: string): boolean {
    const n = evidenceForm(name);
    return n.length > 0 && this.form.includes(n);
  }
}

/** The text around a reader position (±`chars` characters), for the support check. */
export function passageAt(book: BookText, position: number, chars = 600): string {
  const ch = [...book.chapters].reverse().find((c) => c.start <= position) ?? book.chapters[0];
  if (!ch) return '';
  // Walk the chapter's text to the position (counted characters).
  let counted = ch.start;
  let at = 0;
  const chars_ = [...ch.text];
  for (; at < chars_.length && counted < position; at++) if (isCountedChar(chars_[at])) counted++;
  const from = Math.max(0, at - chars);
  const to = Math.min(chars_.length, at + chars);
  return chars_.slice(from, to).join('');
}

/** "Chapter 3 · 41 %": where a position is, for a quote's place. */
export function placeOf(book: BookText, position: number): { chapter: number; percent: number } {
  const ch = [...book.chapters].reverse().find((c) => c.start <= position) ?? book.chapters[0];
  return {
    chapter: ch ? ch.index : 0,
    percent: book.characters ? Math.round((position / book.characters) * 100) : 0,
  };
}
