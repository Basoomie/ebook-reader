/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { IDBPDatabase } from 'idb';
import type BooksDb from '$lib/data/database/books-db/versions/books-db';

export interface LocalTitleSummary {
  title: string;
  hasBookmark: boolean;
  statDays: number;
}

/**
 * What this device holds per title (WP5 device report), read with keys only:
 * book records (with their HTML and images) are never loaded, which matters on
 * the e-reader.
 */
export async function localTitleSummaries(db: IDBPDatabase<BooksDb>): Promise<LocalTitleSummary[]> {
  const tx = db.transaction(['data', 'bookmark', 'statistic'], 'readonly');
  const idsByTitle = new Map<string, number[]>();
  let cursor = await tx.objectStore('data').index('title').openKeyCursor();
  while (cursor) {
    const title = String(cursor.key);
    idsByTitle.set(title, [...(idsByTitle.get(title) ?? []), Number(cursor.primaryKey)]);
    cursor = await cursor.continue();
  }
  const bookmarked = new Set((await tx.objectStore('bookmark').getAllKeys()).map(Number));
  const statDays = new Map<string, number>();
  for (const key of await tx.objectStore('statistic').getAllKeys()) {
    const title = String((key as unknown as [string, string])[0]);
    statDays.set(title, (statDays.get(title) ?? 0) + 1);
  }
  await tx.done;

  const titles = new Set([...idsByTitle.keys(), ...statDays.keys()]);
  return [...titles].sort().map((title) => ({
    title,
    hasBookmark: (idsByTitle.get(title) ?? []).some((id) => bookmarked.has(id)),
    statDays: statDays.get(title) ?? 0
  }));
}

/** This device's saved place for a title (bookmark store), read without loading the book. */
export async function localBookmarkForTitle(
  db: IDBPDatabase<BooksDb>,
  title: string
): Promise<{ charPos: number; at: number } | null> {
  const id = await db.getKeyFromIndex('data', 'title', title);
  if (id === undefined) return null;
  const bookmark = await db.get('bookmark', id);
  if (!bookmark) return null;
  return {
    charPos: Math.max(0, Math.round(bookmark.exploredCharCount ?? 0)),
    at: bookmark.lastBookmarkModified
  };
}
