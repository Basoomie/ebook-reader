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
 *   furigana and gaiji left out (it is what the PC converts to kana and reads aloud);
 *   `ruby` says where in `text` the furigana was used (pronunciation fixes skip those
 *   places and rebuild `reading` from `text`, `ruby` and their own readings).
 * - `position` is the reader position (counted characters before the sentence).
 * - `parts` (Season 2 Phase 12 session 4): the runs of `text` that are dialogue, read by the
 *   dialogue voice (see `dialogueSpans` for the rule). Absent: all narration. Each run names
 *   its quote (`quote`, the quote's number in the book), the same on every sentence of a quote
 *   that spans sentences: per-character voices attribute a speaker to a quote.
 */

import {
  BLOCK_BREAK,
  buildBookTextIndex,
  SENTENCE_END
} from '$lib/components/book-reader/book-search';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';

/**
 * 2: sentences carry their ruby runs (pronunciation fixes, Season 2 Phase 12).
 * 3: sentences carry their dialogue runs (narration and dialogue voices, session 4).
 */
export const BOOK_SCRIPT_VERSION = 3;
/** The dialogue rule `parts` were made with (recorded in each job's voice map). */
export const DIALOGUE_RULE_VERSION = 1;
export const DEFAULT_MAX_SENTENCE = 120;

/**
 * A run of `text` that `reading` replaces by the book's furigana: UTF-16 offsets
 * [start, end) in `text`, and the furigana read there.
 */
export interface RubyRun {
  start: number;
  end: number;
  rt: string;
}

/**
 * A run of `text` that is dialogue: UTF-16 offsets [start, end) in `text`, and the number of
 * its quote in the book (0-based, in reading order).
 */
export interface DialoguePart {
  start: number;
  end: number;
  role: 'dialogue';
  quote: number;
}

export interface ScriptSentence {
  text: string;
  reading: string;
  /** Where `reading` has the book's furigana instead of the text (in text order). */
  ruby: RubyRun[];
  position: number;
  /** The last sentence of its paragraph (a longer pause follows). */
  paragraphEnd: boolean;
  /** The dialogue runs of `text` (in text order); absent when the sentence is all narration. */
  parts?: DialoguePart[];
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

/** A dialogue span of display characters [start, end) (brackets included). */
export interface DialogueSpan {
  start: number;
  end: number;
}

/**
 * What may follow a quote that is a name, title or term rather than speech: a particle or
 * という・といった・とか・との・とは・として, or だ (「死の秘宝」という考え, 「隠れ穴」の境界,
 * 「マント」から, 「面白い人」だったら, 「道具」として).
 */
const TERM_AFTER =
  /^(?:という|といった|とか|との|とは|として|の|を|に|が|は|で|も|や|へ|から|より|まで|だ)/u;
/** What may follow a quote inside a sentence that is speech: と or って (「ウッ」とうなって). */
const SPEECH_AFTER = /^(?:と|って)/u;
/** Speech that ends a sentence ends with one of these (エミリアが「知り合い？」). */
const SPEECH_END = /[。！？!?．…―─〜～]$/u;

/**
 * Season 2 Phase 12 session 4 (decided with the user, 2026-11-16): the dialogue in one text
 * index's display characters, paragraph by paragraph (quotes span sentences, so this runs
 * before the sentence split). Measured on 9 real books (57k sentences):
 *
 * 1. 「 opens a quote and its 」 closes it; 「」 and 『』 inside belong to it. Every quote ends
 *    at the paragraph's end (a speech over several paragraphs reopens with 「). A stray 」 is
 *    ignored.
 * 2. A top-level 「」 is speech when it opens the paragraph or a sentence, unless a particle or
 *    という… follows it (a name or a term); inside a sentence, when と or って follows it (not
 *    という…), when it ends the paragraph, or when it ends the sentence with speech
 *    punctuation inside (。！？… ―; not あの「部屋」。). A quote followed
 *    directly by another (「頑張ります」「一緒に…」) is what the next one is. Otherwise it is a
 *    name, title or term, read as narration.
 * 3. A top-level 『』 is dialogue only when it is the whole paragraph (telepathy, a phone, a
 *    recorded voice); inline 『』 (names, titles) and （） are narration.
 */
export function dialogueSpans(display: string[]): DialogueSpan[] {
  const out: DialogueSpan[] = [];
  let p0 = 0;

  for (let i = 0; i <= display.length; i++) {
    if (i === display.length || display[i] === BLOCK_BREAK) {
      out.push(...paragraphDialogue(display, p0, i));
      p0 = i + 1;
    }
  }

  return out;
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/u.test(ch);

/** The index after the bracket that closes the one opened at `open` (or `end`: unclosed). */
function closeOf(display: string[], open: number, end: number): { at: number; closed: boolean } {
  const stack: string[] = [display[open]];

  for (let k = open + 1; k < end; k++) {
    const ch = display[k];

    if (ch === '「' || ch === '『') {
      stack.push(ch);
    } else if (
      (ch === '」' && stack[stack.length - 1] === '「') ||
      (ch === '』' && stack[stack.length - 1] === '『')
    ) {
      stack.pop();

      if (!stack.length) return { at: k + 1, closed: true };
    }
  }

  return { at: end, closed: false };
}

/** Whether `k` begins a sentence of the paragraph [p0, …): only spaces, or a sentence end before. */
function opensSentence(display: string[], p0: number, k: number): boolean {
  let j = k - 1;

  while (j >= p0 && isSpace(display[j])) j -= 1;

  if (j < p0) return true;

  // Directly after another quote: a run of quotes (its answer is the run's, rule 2).
  if (display[j] === '」' || display[j] === '』') return true;

  while (j >= p0 && CLOSERS.test(display[j])) j -= 1;

  return j >= p0 && SENTENCE_END.has(display[j]);
}

function paragraphDialogue(display: string[], p0: number, p1: number): DialogueSpan[] {
  let a = p0;
  let b = p1;

  while (a < b && isSpace(display[a])) a += 1;
  while (b > a && isSpace(display[b - 1])) b -= 1;

  if (a >= b) return [];

  // A whole-paragraph 『』.
  if (display[a] === '『') {
    const c = closeOf(display, a, b);

    if (c.closed && c.at === b) return [{ start: a, end: b }];
  }

  const quotes: { start: number; end: number; speech: boolean | null }[] = [];
  let k = a;

  while (k < b) {
    const ch = display[k];

    if (ch === '『') {
      // Inline 『』: a name or a title, narration (with any quote inside it).
      const c = closeOf(display, k, b);

      k = c.closed ? c.at : k + 1;
      continue;
    }

    if (ch !== '「') {
      k += 1;
      continue;
    }

    const c = closeOf(display, k, b);
    const after = display.slice(c.at, Math.min(b, c.at + 4)).join('');
    let speech: boolean | null;

    if (!c.closed) {
      speech = true;
    } else if (after.startsWith('「')) {
      speech = null; // what the next quote is
    } else if (opensSentence(display, a, k)) {
      speech = !TERM_AFTER.test(after);
    } else if (TERM_AFTER.test(after)) {
      speech = false;
    } else if (SPEECH_AFTER.test(after)) {
      speech = true;
    } else {
      // Ending the paragraph (エミリアが「知り合い？」, a speaker's name before 「…」): speech. Before a sentence
      // end: speech only with speech punctuation inside (not あの「部屋」。).
      const rest = display.slice(c.at, b).join('');
      const inner = display.slice(k + 1, c.at - 1).join('');

      speech = rest === '' || (SENTENCE_END.has(rest[0]) && SPEECH_END.test(inner));
    }

    quotes.push({ start: k, end: c.at, speech });
    k = c.at;
  }

  for (let q = quotes.length - 1; q >= 0; q--) {
    if (quotes[q].speech === null) quotes[q].speech = quotes[q + 1]?.speech ?? true;
  }

  return quotes.filter((q) => q.speech).map(({ start, end }) => ({ start, end }));
}

/**
 * The dialogue runs of the sentence display[a, b) as UTF-16 offsets in its text, merged so no
 * run (of either voice) is only punctuation: such a piece joins the run before it (or after
 * it, at the start). Spans give the quote numbers (`quoteOf`, by span index).
 */
function sentenceParts(
  display: string[],
  a: number,
  b: number,
  spans: DialogueSpan[],
  quoteOf: (span: number) => number
): DialoguePart[] | undefined {
  type Piece = { from: number; to: number; quote: number | null };
  const pieces: Piece[] = [];
  let at = a;

  spans.forEach((s, i) => {
    const from = Math.max(a, s.start);
    const to = Math.min(b, s.end);

    if (from >= to) return;
    if (from > at) pieces.push({ from: at, to: from, quote: null });
    pieces.push({ from, to, quote: quoteOf(i) });
    at = to;
  });

  if (!pieces.some((p) => p.quote !== null)) return undefined;
  if (at < b) pieces.push({ from: at, to: b, quote: null });

  const speakable = (p: Piece) =>
    SPEAKABLE.test(display.slice(p.from, p.to).join('').replace(new RegExp(GAIJI_MARK, 'gu'), ''));
  const merged: Piece[] = [];

  for (const p of pieces) {
    const last = merged[merged.length - 1];

    if (last && (!speakable(p) || !speakable(last))) {
      // A piece with nothing to say joins its neighbour (the one that has something to say).
      last.quote = speakable(last) ? last.quote : p.quote;
      last.to = p.to;
    } else {
      merged.push({ ...p });
    }
  }

  // UTF-16 offsets in the sentence's text.
  const offset: number[] = [];
  let u = 0;

  for (let k = a; k <= b; k++) {
    offset[k - a] = u;
    if (k < b) u += display[k].length;
  }

  const parts = merged
    .filter((p) => p.quote !== null)
    .map((p) => ({
      start: offset[p.from - a],
      end: offset[p.to - a],
      role: 'dialogue' as const,
      quote: p.quote as number
    }));

  return parts.length ? parts : undefined;
}

/** The script of one spine item's element, positions offset by `offset`. */
function elementSentences(
  element: Element,
  offset: number,
  maxSentence: number,
  quotes: { next: number }
): { sentences: ScriptSentence[]; total: number } {
  const index = buildBookTextIndex(element, true);
  const { display, countBefore, nodeAt } = index;
  const sentences: ScriptSentence[] = [];
  const spans = dialogueSpans(display);
  const firstQuote = quotes.next;

  quotes.next += spans.length;

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
      const runs: RubyRun[] = [];
      let at = 0;

      for (let k = a; k < b; k++) {
        const ch = display[k];
        const from = at;

        at += ch.length;

        if (ch === GAIJI_MARK) {
          lastRuby = null;
          continue;
        }

        const ruby = rubyOf(nodeAt[k], element);
        const rt = ruby ? rubyReading(ruby) : '';

        if (ruby && rt) {
          if (ruby !== lastRuby) {
            reading += rt;
            runs.push({ start: from, end: at, rt });
          } else {
            runs[runs.length - 1].end = at;
          }
          lastRuby = ruby;
        } else {
          reading += ch;
          lastRuby = null;
        }
      }

      const parts = sentenceParts(display, a, b, spans, (i) => firstQuote + i);

      sentences.push({
        text,
        reading,
        ruby: runs,
        position: offset + countBefore[a],
        paragraphEnd: range.paragraphEnd,
        ...(parts ? { parts } : {})
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
  const quotes = { next: 0 };

  for (const chapter of chapters) {
    const startCharacter = offset;
    const sentences: ScriptSentence[] = [];

    for (const part of chapter.parts) {
      const result = elementSentences(part, offset, maxSentence, quotes);

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
