/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApi } from './api';
import { refreshAuthors, rememberedAuthors } from './book-authors';
import { getLibraryStore } from './library-db';
import { libraryRequestTimeoutSeconds$ } from './settings';

/**
 * WP19d: the author for a quote image made in the reader: the one this device remembers,
 * shown at once, and `refresh` asking the library server (the Library's request timeout
 * applies). Loaded by the reader only when Quote image is pressed; never part of reading.
 */
export async function readerQuoteAuthor(
  localId: number
): Promise<{ author: string; refresh: () => Promise<string | null> }> {
  const store = getLibraryStore();
  const { author } = await rememberedAuthors(store, localId);

  async function refresh(): Promise<string | null> {
    const connection = await store.getConnection();
    if (!connection) return null;
    const timeout = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
    const api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    return refreshAuthors(store, (ids) => api.lookup(ids), localId);
  }

  return { author, refresh };
}
