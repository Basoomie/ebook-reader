/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Section } from '../../../data/database/books-db/versions/v3/books-db-v3';
import extractEpub from './extract-epub';
import generateEpubHtml, { type EpubHtmlImportOptions } from './generate-epub-html';
import { getCharacterCount } from '$lib/functions/get-character-count';
import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';

export interface EpubCountResult {
  /** Same value the browser import stores as `characters`. */
  characters: number;
  /** Same value the browser import stores as `sections`. */
  sections: Section[];
  /** The imported HTML, as stored in `elementHtml`. */
  elementHtml: string;
}

/**
 * Runs the import steps that determine character counts (extractEpub + generateEpubHtml),
 * exactly as `loadEpub` does, without the store, covers or styles.
 * Works in the browser and, with a DOM installed, in Node.
 */
export async function countEpub(
  epub: Blob,
  document: Document,
  options: EpubHtmlImportOptions
): Promise<EpubCountResult> {
  const { contents, result: data, contentsDirectory } = await extractEpub(epub);
  const result = generateEpubHtml(data, contents, document, contentsDirectory, options);

  return {
    characters: result.characters,
    sections: result.sections,
    elementHtml: result.element.innerHTML
  };
}

/**
 * The reader's in-book total for already imported HTML: the same formula as
 * CharacterStatsCalculator (sum of getCharacterCount over getParagraphNodes).
 * Display-only transforms applied before rendering (image URLs, wrapper classes) do
 * not change text and are not applied here.
 */
export function countHtml(elementHtml: string, document: Document) {
  const container = document.createElement('div');

  container.innerHTML = elementHtml;

  return getParagraphNodes(container).reduce((acc, node) => acc + getCharacterCount(node), 0);
}
