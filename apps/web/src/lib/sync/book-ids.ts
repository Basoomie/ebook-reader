/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Server book ids of local books (WP5). Local books are keyed by title. A
 * book opened from the Calibre library has a WP6 link; a book that existed
 * before was linked by the migration and has a `legacy-book` record (written
 * by the server, pulled into the local mirror, so this works offline).
 */

/** The migrated link of a local title, or null. */
export async function legacyBookIdForTitle(
  engine: SyncEngine,
  title: string
): Promise<string | null> {
  const matches = (await engine.getAll('legacy-book')).filter(
    (r) => r.deletedAt === null && r.data.title === title && typeof r.data.bookId === 'string'
  );
  return matches.length === 1 ? (matches[0].data.bookId as string) : null;
}

export interface BookIdDeps {
  getEngine(): Promise<SyncEngine>;
  allLinks(): Promise<CalibreLink[]>;
  warn(message: string): void;
}

/**
 * The server book id for a local title (statistics are keyed by title): its
 * Calibre link when there is exactly one, else its migrated link.
 */
export async function bookIdForTitle(title: string, deps: BookIdDeps): Promise<string | null> {
  const links = (await deps.allLinks()).filter((l) => l.title === title);
  const ids = new Set(links.map((l) => l.bookId));
  if (ids.size > 1) {
    deps.warn(`Sync: "${title}" has several Calibre links; skipped`);
    return null;
  }
  if (ids.size === 1) return links[0].bookId;
  return legacyBookIdForTitle(await deps.getEngine(), title);
}

/** Local titles per server book id (Calibre links and migrated links). */
export async function titlesByBookId(deps: BookIdDeps): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (bookId: string, title: string) => {
    const set = out.get(bookId) ?? new Set<string>();
    set.add(title);
    out.set(bookId, set);
  };
  for (const link of await deps.allLinks()) add(link.bookId, link.title);
  for (const r of await (await deps.getEngine()).getAll('legacy-book')) {
    if (
      r.deletedAt === null &&
      typeof r.data.bookId === 'string' &&
      typeof r.data.title === 'string'
    ) {
      add(r.data.bookId, r.data.title);
    }
  }
  return out;
}
