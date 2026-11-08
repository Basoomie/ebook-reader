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
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import { configure as zipConfigure } from '@zip.js/zip.js';
import { installNodeDom } from './node-dom';
import { readFile } from 'node:fs/promises';

/** Same defaults as `importHTMLFixMode$` / `restrictImportFixToAnchor$` in the store. */
export const defaultEpubImportOptions: Readonly<EpubHtmlImportOptions> = {
  importHTMLFixMode: ImportHTMLFixMode.OFF,
  restrictImportFixToAnchor: true
};

function prepareNode() {
  const document = installNodeDom();

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
  const document = prepareNode();
  const bytes = Uint8Array.from(typeof input === 'string' ? await readFile(input) : input);

  return countEpub(new Blob([bytes]), document, options);
}

/** The reader's in-book total for stored `elementHtml`, computed in Node. */
export function countStoredHtml(elementHtml: string) {
  return countHtml(elementHtml, prepareNode());
}
