/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';
import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';
import { getCountedText } from '$lib/functions/get-character-count';

/**
 * Phase 6 stage 3 (content duplicates): a book's text exactly as the reader counts it
 * (getParagraphNodes + getCountedText over the imported HTML: furigana in <rt> and hidden
 * text left out, punctuation and other non-Japanese characters dropped, a gaiji image as
 * one character). Its length in code points equals the reader's character count.
 */
export interface BookText {
  /** The counted characters, in reading order. */
  text: string;
  /** Code points in `text` (= the reader's character count). */
  characters: number;
  /**
   * The reader's chapters (main TOC sections, as the book script groups them): where each
   * starts in `text`, in code points.
   */
  chapters: { start: number; label: string }[];
  /** <ruby> elements in the imported HTML. */
  ruby: number;
  /** TOC entries the import found (sections that are main chapters). */
  tocEntries: number;
}

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A high surrogate followed by a low one is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** The counted text of imported HTML (`elementHtml` and `sections` as the import stores them). */
export function bookTextFromHtml(
  elementHtml: string,
  sections: Section[],
  document: Document
): BookText {
  const container = document.createElement('div');

  container.innerHTML = elementHtml;

  return bookTextFromElement(container, sections);
}

/**
 * The counted text of the import's own element (`generateEpubHtml`'s `element`, whose
 * children are the sections), read without serializing it to `elementHtml` and parsing that
 * again: the same nodes in the same order, read once (stage 3 reads every book of the library).
 */
export function bookTextFromElement(container: Element, sections: Section[]): BookText {
  const sectionOf = new Map(sections.map((s) => [s.reference, s]));
  const parts: string[] = [];
  const chapters: { start: number; label: string }[] = [];
  let offset = 0;

  for (const child of Array.from(container.children)) {
    const section = sectionOf.get(child.id);

    if (!chapters.length || (section && !section.parentChapter)) {
      chapters.push({ start: offset, label: section?.label?.trim() ?? '' });
    }
    for (const node of getParagraphNodes(child)) {
      const piece = getCountedText(node);

      if (!piece) continue;
      parts.push(piece);
      offset += codePoints(piece);
    }
  }

  return {
    text: parts.join(''),
    characters: offset,
    chapters,
    ruby: container.getElementsByTagName('ruby').length,
    tocEntries: sections.filter((s) => !s.parentChapter && s.label?.trim()).length
  };
}
