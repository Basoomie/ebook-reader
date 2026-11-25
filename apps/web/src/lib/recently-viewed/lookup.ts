/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CatalogBook } from '$lib/library/types';

/** The lookup takes at most this many ids per request. */
const LOOKUP_BATCH = 200;

/**
 * Recently viewed: the catalog's cards of the given books, in the given order. Books the
 * library no longer has (or hides) are left out.
 */
export async function lookupInOrder(
  source: { lookup(ids: readonly string[]): Promise<{ books: CatalogBook[] }> },
  ids: readonly string[]
): Promise<CatalogBook[]> {
  const byId = new Map<string, CatalogBook>();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const { books } = await source.lookup(ids.slice(i, i + LOOKUP_BATCH));
    for (const book of books) byId.set(book.id, book);
  }
  return ids.map((id) => byId.get(id)).filter((b): b is CatalogBook => !!b);
}
