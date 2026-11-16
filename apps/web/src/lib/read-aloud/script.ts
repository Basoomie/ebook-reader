/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { bookScriptFromHtml, type ScriptSentence } from '$lib/audio/book-script';
import { isCountedChar } from '$lib/components/book-reader/book-search';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';

/**
 * Season 2 Phase 12 session 3: the sentences read-aloud reads, built on this device from
 * its own copy of the book with the reader's own code (book-script.ts, the same as a
 * generated audiobook's): the text as shown, the reading with the book's furigana, the
 * furigana runs (the server's pronunciation fixes skip them) and the reader position.
 * Built from this device's copy, so the positions are exactly the reader's here, whatever
 * import settings this device has.
 */

const GAIJI_MARK = '〓';

export interface ReadAloudLine extends ScriptSentence {
  /** Index in the book's lines. */
  index: number;
  /** Reader position after the sentence: [position, end) are its counted characters. */
  end: number;
  /** 0-based chapter (the script's). */
  chapter: number;
}

/** Counted characters of a sentence's text (a gaiji, shown as 〓, counts one). */
export function countedLength(text: string): number {
  let n = 0;

  for (const ch of text) {
    if (ch === GAIJI_MARK || isCountedChar(ch)) n += 1;
  }

  return n;
}

export class ReadAloudScript {
  constructor(readonly lines: ReadAloudLine[]) {}

  /**
   * The book's lines from its stored HTML, parsed in an inert document (no images load, no
   * scripts run).
   */
  static build(
    elementHtml: string,
    sections: Section[],
    characters: number,
    doc: Document = document.implementation.createHTMLDocument('')
  ): ReadAloudScript {
    const script = bookScriptFromHtml(elementHtml, sections, characters, doc);
    const lines: ReadAloudLine[] = [];

    for (const chapter of script.chapters) {
      for (const s of chapter.sentences) {
        lines.push({
          ...s,
          index: lines.length,
          end: s.position + countedLength(s.text),
          chapter: chapter.index
        });
      }
    }

    return new ReadAloudScript(lines);
  }

  /**
   * The line to start at for reader position `position`: the line the position is inside
   * (the last line starting at or before it, when it ends after it), else the first line
   * after it. -1 when nothing is left to read.
   */
  startAt(position: number): number {
    const lines = this.lines;
    let lo = 0;
    let hi = lines.length;

    // First line starting after `position`.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (lines[mid].position <= position) lo = mid + 1;
      else hi = mid;
    }

    const before = lo - 1;

    if (before >= 0 && lines[before].end > position) return before;

    return lo < lines.length ? lo : -1;
  }
}
