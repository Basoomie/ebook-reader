/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Entry point of the storage server's character counter
 * (`apps/storage-server/vendor/epub-count.cjs`, built by `pnpm build:server-counter`).
 * The server runs exactly this code, so its counts follow the reader's import and
 * counting rules. Image bytes are skipped: counts depend on image keys only.
 */

import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';
import type { EpubHtmlImportOptions } from '$lib/functions/file-loaders/epub/generate-epub-html';
import { bookScriptEpubBlob, countEpubBlob, defaultEpubImportOptions } from './count-epub-node';
import type { BookScript } from './book-script';

export { EPUB_COUNT_VERSION } from '$lib/functions/file-loaders/epub/count-epub';
export { BOOK_SCRIPT_VERSION } from './book-script';
export { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
export { defaultEpubImportOptions };
export type { EpubHtmlImportOptions, BookScript };

/**
 * WP17: the chapters and sentences a generated audiobook reads (book-script.ts), from the
 * reader's own import. Same Blob stand-in as countEpubForServer.
 */
export async function bookScriptForServer(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions,
  scriptOptions: { maxSentence?: number } = {}
): Promise<BookScript> {
  return bookScriptEpubBlob(epub, options, scriptOptions);
}

export interface ServerCountResult {
  characters: number;
  sections: Section[];
}

/**
 * `epub` may be a real Blob or a read-only stand-in with `size`, `slice(start, end)` and
 * `arrayBuffer()`: zip.js's BlobReader (2.4.26, pinned) uses nothing else. The server
 * passes such a stand-in so one open file serves the ~200 small reads per book.
 */
export async function countEpubForServer(
  epub: Blob,
  options: EpubHtmlImportOptions = defaultEpubImportOptions
): Promise<ServerCountResult> {
  const { characters, sections } = await countEpubBlob(epub, options, { imageData: false });

  return { characters, sections };
}
