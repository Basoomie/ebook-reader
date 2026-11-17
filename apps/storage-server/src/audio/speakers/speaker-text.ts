/**
 * Season 2 Phase 12 session 5 (per-character voices): the book as the speaker model reads it.
 *
 * The book script (book-script.ts, v3) numbers every quote (`parts[].quote`): the unit a
 * speaker is attributed to. Sentences carry `paragraphEnd` but no paragraph id, so the
 * paragraphs are rebuilt here (sentences up to the one that ends a paragraph), each with its
 * quotes as offsets in the paragraph's text. A quote over several sentences of a paragraph
 * becomes one span. A quote number whose run was merged away (only punctuation) is absent.
 */
import type { BookScript } from '../book-script';

export interface QuoteSpan {
  quote: number;
  /** UTF-16 offsets in the paragraph's `text`. */
  start: number;
  end: number;
}

export interface SpeakerParagraph {
  index: number;
  chapter: number;
  /** The reader position (counted characters) of its first sentence. */
  position: number;
  text: string;
  quotes: QuoteSpan[];
}

export interface SpeakerQuote {
  quote: number;
  chapter: number;
  paragraph: number;
  position: number;
  text: string;
  /** What finds the quote again after a renumbering (textKey + its occurrence). */
  key: string;
}

export interface SpeakerBook {
  paragraphs: SpeakerParagraph[];
  /** In reading order. */
  quotes: SpeakerQuote[];
}

/** The first 40 characters of a quote's text, NFKC, without white space. */
export function textKey(text: string): string {
  return Array.from(text.normalize('NFKC').replace(/\s+/gu, '')).slice(0, 40).join('');
}

/** Paragraphs and quotes of a book script. */
export function speakerBook(script: BookScript): SpeakerBook {
  const paragraphs: SpeakerParagraph[] = [];
  for (const chapter of script.chapters) {
    let text = '';
    let spans: QuoteSpan[] = [];
    let position = -1;
    const flush = () => {
      if (text.trim()) {
        paragraphs.push({
          index: paragraphs.length,
          chapter: chapter.index,
          position,
          text,
          quotes: spans,
        });
      }
      text = '';
      spans = [];
      position = -1;
    };
    for (const s of chapter.sentences) {
      if (position < 0) position = s.position;
      const base = text.length;
      for (const p of s.parts ?? []) {
        const last = spans[spans.length - 1];
        // A quote over several sentences: one span (only white space between its pieces).
        if (last && last.quote === p.quote && !text.slice(last.end, base + p.start).trim()) {
          last.end = base + p.end;
        } else {
          spans.push({ quote: p.quote, start: base + p.start, end: base + p.end });
        }
      }
      text += s.text;
      if (s.paragraphEnd) flush();
    }
    flush();
  }
  const quotes: SpeakerQuote[] = [];
  const seen = new Map<string, number>();
  for (const p of paragraphs) {
    for (const q of p.quotes) {
      const qt = p.text.slice(q.start, q.end);
      const k = textKey(qt);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      quotes.push({
        quote: q.quote,
        chapter: p.chapter,
        paragraph: p.index,
        position: p.position,
        text: qt,
        key: `${n}|${k}`,
      });
    }
  }
  return { paragraphs, quotes };
}
