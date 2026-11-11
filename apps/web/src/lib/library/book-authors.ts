/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink, LibraryStore } from './library-db';

/**
 * WP19d: the authors of a book on this device, for quote images made in the reader. The
 * reader's own book data has none; the link to the catalog book remembers them (written
 * when the book is opened from the library). The server is still asked each time, so an
 * author corrected in Calibre replaces the remembered one.
 */

type LinkStore = Pick<LibraryStore, 'getLinksForLocalId' | 'putLink'>;
export type AuthorLookup = (
  ids: string[]
) => Promise<{ books: { id: string; authors: { name: string }[] }[] }>;

const joined = (names: readonly string[] | undefined) => (names ?? []).filter(Boolean).join(', ');

/** The remembered authors ('' when none) and the catalog book's id (null when not linked). */
export async function rememberedAuthors(
  store: LinkStore,
  localId: number
): Promise<{ author: string; catalogId: string | null }> {
  const links = await store.getLinksForLocalId(localId);
  const link = links.find((l) => l.authors?.length) ?? links[0];
  return { author: joined(link?.authors), catalogId: link?.bookId ?? null };
}

/**
 * Asks the server for the authors and updates the links that remember something else.
 * Returns the authors joined ('' when the catalog lists none), or null when the book isn't
 * linked or the server didn't return it.
 */
export async function refreshAuthors(
  store: LinkStore,
  lookup: AuthorLookup,
  localId: number
): Promise<string | null> {
  const links = await store.getLinksForLocalId(localId);
  if (!links.length) return null;
  const ids = [...new Set(links.map((l) => l.bookId))];
  const { books } = await lookup(ids);
  const found = books.find((b) => ids.includes(b.id));
  if (!found) return null;
  const names = found.authors.map((a) => a.name).filter(Boolean);
  for (const link of links) {
    if (JSON.stringify(link.authors ?? null) !== JSON.stringify(names)) {
      const next: CalibreLink = { ...link, authors: names };
      await store.putLink(next);
    }
  }
  return joined(names);
}
