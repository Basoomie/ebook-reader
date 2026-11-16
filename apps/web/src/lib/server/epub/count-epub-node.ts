/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  countEpub,
  countHtml,
  type EpubCountResult
} from '$lib/functions/file-loaders/epub/count-epub';
import type { EpubHtmlImportOptions } from '$lib/functions/file-loaders/epub/generate-epub-html';
import type { ExtractEpubOptions } from '$lib/functions/file-loaders/epub/extract-epub';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import { configure as zipConfigure } from '@zip.js/zip.js';
import { installNodeDom, renewNodeDom } from './node-dom';
import { readFile } from 'node:fs/promises';
import { bookScriptFromHtml, type BookScript } from './book-script';
import { bookTextFromElement, type BookText } from './book-text';
import extractEpub from '$lib/functions/file-loaders/epub/extract-epub';
import generateEpubHtml from '$lib/functions/file-loaders/epub/generate-epub-html';
import { collectIllustrations, opfCoverKey } from '$lib/library/illustrations/collect';
import {
  ILLUSTRATIONS_RULE_VERSION,
  type Illustration
} from '$lib/library/illustrations/pick-illustrations';
import path from 'path-browserify';

/** Same defaults as `importHTMLFixMode$` / `restrictImportFixToAnchor$` in the store. */
export const defaultEpubImportOptions: Readonly<EpubHtmlImportOptions> = {
  importHTMLFixMode: ImportHTMLFixMode.OFF,
  restrictImportFixToAnchor: true
};

function prepareNode(fresh = false) {
  const document = fresh ? renewNodeDom() : installNodeDom();

  // Node has no Web Workers; the shared init-zip-settings enables them when `window`
  // is missing. Inflating in the main thread gives identical output.
  zipConfigure({ useWebWorkers: false });

  return document;
}

/**
 * Counts an EPUB in Node with the browser import code.
 * The file is only read; nothing is ever written next to it.
 */
export async function countEpubFile(
  input: string | Uint8Array,
  options: EpubHtmlImportOptions = defaultEpubImportOptions
): Promise<EpubCountResult> {
  const bytes = Uint8Array.from(typeof input === 'string' ? await readFile(input) : input);

  return countEpubBlob(new Blob([bytes]), options);
}

/**
 * Counts an EPUB given as a Blob. A file-backed Blob (`fs.openAsBlob`) is read lazily:
 * zip.js reads only the central directory and the entries it extracts, so with
 * `{ imageData: false }` the image bytes are never read.
 */
export async function countEpubBlob(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions,
  extractOptions: ExtractEpubOptions = {}
): Promise<EpubCountResult> {
  // A fresh window per book: jsdom would otherwise keep every parsed chapter (node-dom.ts).
  return countEpub(epub, prepareNode(true), options, extractOptions);
}

/**
 * WP17: the text a generated audiobook reads (book-script.ts), from the same import.
 * Image bytes are never read.
 */
export async function bookScriptEpubBlob(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions,
  scriptOptions: { maxSentence?: number } = {}
): Promise<BookScript> {
  const document = prepareNode(true);
  const { elementHtml, sections, characters } = await countEpub(epub, document, options, {
    imageData: false
  });

  return bookScriptFromHtml(elementHtml, sections, characters, document, scriptOptions);
}

/**
 * Phase 6 stage 3: the book's counted text (book-text.ts), from the same import.
 * Image bytes are never read.
 */
export async function bookTextEpubBlob(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions
): Promise<BookText & { importCharacters: number }> {
  const document = prepareNode(true);
  // The import as countEpub runs it, but its element is read directly: serializing it to
  // elementHtml and parsing that again doubled the work per book.
  const {
    contents,
    result: data,
    contentsDirectory
  } = await extractEpub(epub, {
    imageData: false
  });
  const { element, sections, characters } = generateEpubHtml(
    data,
    contents,
    document,
    contentsDirectory,
    options
  );

  return { ...bookTextFromElement(element, sections), importCharacters: characters };
}

/** The reader's in-book total for stored `elementHtml`, computed in Node. */
export function countStoredHtml(elementHtml: string) {
  return countHtml(elementHtml, prepareNode());
}

export interface ServerIllustration extends Illustration {
  /** The image's path inside the EPUB (what the server reads to serve it). */
  entry: string;
}

export interface ServerIllustrations {
  version: number;
  items: ServerIllustration[];
}

/**
 * Season 2 §6: the book's illustrations, with the reader's own import and the same rule
 * the device applies to its stored copy (lib/library/illustrations). Image bytes are read
 * (their sizes decide), but only the candidates' headers are looked at.
 */
export async function illustrationsEpubBlob(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions
): Promise<ServerIllustrations> {
  const document = prepareNode(true);
  const { contents, result, contentsDirectory } = await extractEpub(epub);
  const { element } = generateEpubHtml(result, contents, document, contentsDirectory, options);
  const blobs = Object.fromEntries(
    Object.entries(result).filter((entry): entry is [string, Blob] => entry[1] instanceof Blob)
  );
  const coverKey = opfCoverKey(contents, new Set(Object.keys(blobs)));
  const items = await collectIllustrations(element, blobs, coverKey);

  return {
    version: ILLUSTRATIONS_RULE_VERSION,
    // The same path extract-epub opened the entry by.
    items: items.map((item) => ({ ...item, entry: path.join(contentsDirectory, item.key) }))
  };
}
