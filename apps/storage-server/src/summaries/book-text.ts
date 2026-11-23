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

/** A heading with the book's own furigana: each piece of text with its reading, if any. */
export type RubyPiece = { t: string; r?: string };

const KANJI = /[\p{Unified_Ideograph}々〆ヶ]/u;
/** What separates the names in a heading (フェル(フェルディア), 紅龍師団・黒龍師団, …). */
const NAME_SEPARATORS = /([()（）［］[\]／/・、,，＆&]+)/;
const NAME_SEPARATORS_ONE = /^[()（）［］[\]／/・、,，＆&]+$/;

/**
 * The book's furigana (ruby) by the text it sits on, from the reader's import. A name or term
 * gets its reading only from here, never from a model: each run of kanji in it must be covered
 * whole by ruby the book has (pieces of two or more characters, or the whole run), else that run
 * keeps no reading. Where the book gives one text several readings, the most frequent wins.
 */
export class RubyIndex {
  private readonly readings = new Map<string, Map<string, number>>();
  private longest = 0;
  /** Sentences with ruby, to read a word's furigana where the book prints that word. */
  private readonly withRuby: {
    text: string;
    ruby: { start: number; end: number; rt: string }[];
  }[] = [];

  constructor(script: BookScript) {
    for (const c of script.chapters)
      for (const s of c.sentences) {
        if (s.ruby?.length) this.withRuby.push({ text: s.text, ruby: s.ruby });
        for (const r of s.ruby ?? []) {
          const base = s.text.slice(r.start, r.end);
          if (!base || !r.rt || !KANJI.test(base)) continue;
          const m = this.readings.get(base) ?? new Map<string, number>();
          m.set(r.rt, (m.get(r.rt) ?? 0) + 1);
          this.readings.set(base, m);
          this.longest = Math.max(this.longest, [...base].length);
        }
      }
  }

  /**
   * The furigana of a word where the book prints it: every kanji of the word under ruby that
   * lies inside the word (books that give ruby kanji by kanji, 北(ほつ)邦(ぽう)の瑪(め)瑙(のう),
   * included). Where the book prints it with different readings, the most frequent wins.
   */
  private inPlace(word: string): RubyPiece[] | null {
    if (!KANJI.test(word)) return null;
    const found = new Map<string, { pieces: RubyPiece[]; n: number }>();
    for (const s of this.withRuby) {
      for (let at = s.text.indexOf(word); at >= 0; at = s.text.indexOf(word, at + 1)) {
        const end = at + word.length;
        const spans = s.ruby
          .filter((r) => r.start >= at && r.end <= end && r.rt)
          .sort((a, b) => a.start - b.start);
        const covered = new Set<number>();
        for (const r of spans) for (let k = r.start; k < r.end; k++) covered.add(k);
        let whole = true;
        for (let k = at; k < end; k++) if (KANJI.test(s.text[k]) && !covered.has(k)) whole = false;
        if (!whole) continue;
        const pieces: RubyPiece[] = [];
        let k = at;
        for (const r of spans) {
          if (r.start > k) pieces.push({ t: s.text.slice(k, r.start) });
          pieces.push({ t: s.text.slice(r.start, r.end), r: r.rt });
          k = r.end;
        }
        if (k < end) pieces.push({ t: s.text.slice(k, end) });
        const key = JSON.stringify(pieces);
        const f = found.get(key) ?? { pieces, n: 0 };
        f.n++;
        found.set(key, f);
      }
    }
    let best: { pieces: RubyPiece[]; n: number } | null = null;
    for (const [, f] of [...found.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
      if (!best || f.n > best.n) best = f;
    return best?.pieces ?? null;
  }

  /**
   * A heading split into pieces with readings, or null when no piece has one. Each name in the
   * heading (namesIn) is read where the book prints it; failing that, from ruby the book gives the
   * same text elsewhere.
   */
  pieces(heading: string): RubyPiece[] | null {
    const out: RubyPiece[] = [];
    let any = false;
    const plain = (t: string) => {
      const last = out[out.length - 1];
      if (last && last.r === undefined) last.t += t;
      else out.push({ t });
    };
    for (const part of heading.split(NAME_SEPARATORS)) {
      if (!part) continue;
      if (NAME_SEPARATORS_ONE.test(part)) {
        plain(part);
        continue;
      }
      const p = this.inPlace(part) ?? this.fromBases(part);
      if (!p) {
        plain(part);
        continue;
      }
      any = true;
      for (const x of p) {
        if (x.r === undefined) plain(x.t);
        else out.push(x);
      }
    }
    return any ? out : null;
  }

  /** The reading the book gives `base` most often, or null. */
  readingOf(base: string): string | null {
    const m = this.readings.get(base);
    if (!m) return null;
    let best: string | null = null;
    let n = 0;
    for (const [rt, c] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
      if (c > n) {
        best = rt;
        n = c;
      }
    return best;
  }

  /** A text split into pieces with readings from ruby the book gives that text anywhere. */
  private fromBases(text: string): RubyPiece[] | null {
    const chars = [...text];
    const out: RubyPiece[] = [];
    const plain = (t: string) => {
      const last = out[out.length - 1];
      if (last && last.r === undefined) last.t += t;
      else out.push({ t });
    };
    let i = 0;
    let any = false;
    while (i < chars.length) {
      if (!KANJI.test(chars[i])) {
        plain(chars[i++]);
        continue;
      }
      let j = i;
      while (j < chars.length && KANJI.test(chars[j])) j++;
      const run = chars.slice(i, j);
      // A single kanji takes a reading only when it is the whole heading: next to kana it may be
      // read differently from where the book gives its ruby (白い結婚 is しろい, not 白貂's はく).
      const covered = run.length === 1 && chars.length > 1 ? null : this.cover(run);
      if (covered) {
        out.push(...covered);
        any = true;
      } else plain(run.join(''));
      i = j;
    }
    return any ? out : null;
  }

  /** A run of kanji covered whole by the book's ruby, longest pieces first. */
  private cover(run: string[]): RubyPiece[] | null {
    const whole = this.readingOf(run.join(''));
    if (whole) return [{ t: run.join(''), r: whole }];
    const out: RubyPiece[] = [];
    let i = 0;
    while (i < run.length) {
      let hit: RubyPiece | null = null;
      for (let len = Math.min(this.longest, run.length - i); len >= 2; len--) {
        const base = run.slice(i, i + len).join('');
        const r = this.readingOf(base);
        if (r) {
          hit = { t: base, r };
          break;
        }
      }
      if (!hit) return null;
      out.push(hit);
      i += [...hit.t].length;
    }
    return out;
  }
}

/**
 * A written text as the app shows it: a literal "\n" a model wrote turns into a line break, ids a
 * model put into the text go, and only the overview keeps paragraphs (other items are one line).
 */
export function cleanWritten(text: string, lang: string, paragraphs: boolean): string {
  let t = text.replace(/\\n/g, '\n');
  t = t.replace(/\s*[（(]\s*(?:(?:sonnet|sol|opus|gemma):\d+:\d+\s*[,、，]?\s*)+[)）]/g, '');
  t = paragraphs
    ? t.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
    : t.replace(/\s*\n+\s*/g, lang === 'ja' ? '' : ' ');
  return t.trim();
}

/**
 * The names a heading is made of, each to be found in the book: a heading may give a name with
 * its other names in brackets or side by side (フェル(フェルディア), 紅龍師団・黒龍師団,
 * 白い結婚／ワルプルギスの夜). The parts of a real name are in the book too, so splitting at ・
 * never rejects one.
 */
export function namesIn(heading: string): string[] {
  return heading
    .split(NAME_SEPARATORS)
    .filter((p) => !NAME_SEPARATORS_ONE.test(p))
    .map((p) => p.trim())
    .filter(Boolean);
}
