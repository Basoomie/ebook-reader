/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Search history (2026-11-24, docs/design/search-history.md): pure rules, no storage.
 *
 * One synced record per remembered search (kind "search-history"):
 *   lib:<hash>   the library search box
 *   book:<hash>  "Search in this book", one per book and search
 * The hash is of the search's key, so the same search typed again (on any device) is the
 * same record: it moves to the top and is never listed twice. The newest typed form shows.
 */

import { normalizeForSearch } from '$lib/components/book-reader/book-search';
import { matchesQuery, queryWords } from '$lib/settings/paged-list';

export const SEARCH_HISTORY_KIND = 'search-history';
/** The server's limits (storage-server src/sync/kinds.ts). */
export const MAX_LIBRARY_SEARCH = 500;
export const MAX_BOOK_SEARCH = 200;
export const MAX_SEARCH_TITLE = 200;

export type HistoryScope = 'lib' | 'book';

export interface HistoryEntry {
  /** The record id (lib:<hash> or book:<hash>). */
  id: string;
  scope: HistoryScope;
  query: string;
  usedAt: number;
  /** Book searches: the book's key (server id, or local:<device>:<id>) and title. */
  book?: string;
  title?: string;
}

/** The book a reader search belongs to. */
export interface HistoryBook {
  key: string;
  title: string;
}

/** Library: trimmed, runs of spaces as one. Case is kept (regex terms are case-sensitive). */
export function libraryKey(query: string): string {
  return query.trim().replace(/\s+/gu, ' ');
}

/** Reader: the book search's own normalization, so two texts with one key find the same. */
export function bookSearchKey(query: string): string {
  return normalizeForSearch(query);
}

/** The key of a book outside the catalog: only matches on the device that has it. */
export function localBookKey(deviceId: string, localId: number): string {
  return `local:${deviceId}:${localId}`;
}

/**
 * FNV-1a 64-bit of the string's UTF-16 code units, as 16 hex digits. Not crypto.subtle (the
 * app runs on plain http) and no BigInt: four 16-bit limbs, the prime being 2^40 + 0x1b3.
 */
export function fnv1a64(text: string): string {
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < text.length; i++) {
    h0 ^= text.charCodeAt(i) & 0xffff;
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8);
    let t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    t3 += t2 >>> 16;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, '0')).join('');
}

export function libraryRecordId(query: string): string {
  return `lib:${fnv1a64(libraryKey(query))}`;
}

export function bookRecordId(bookKey: string, query: string): string {
  return `book:${fnv1a64(`${bookKey}\n${bookSearchKey(query)}`)}`;
}

/** A stored record as an entry, or null when it is deleted or not one of ours. */
export function entryOf(record: {
  id: string;
  deletedAt: number | null;
  data: Record<string, unknown>;
}): HistoryEntry | null {
  if (record.deletedAt !== null) return null;
  const scope = record.id.startsWith('lib:')
    ? 'lib'
    : record.id.startsWith('book:')
      ? 'book'
      : null;
  const { query, usedAt, book, title } = record.data;
  if (!scope || typeof query !== 'string' || !query || typeof usedAt !== 'number') return null;
  if (scope === 'lib') return { id: record.id, scope, query, usedAt };
  if (typeof book !== 'string') return null;
  return {
    id: record.id,
    scope,
    query,
    usedAt,
    book,
    title: typeof title === 'string' ? title : ''
  };
}

export function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  return b.usedAt - a.usedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The entries that match what is typed (every word, width and kana folded), newest first.
 * The entry that is exactly what is typed is left out: it would only repeat the box.
 */
export function filterEntries(
  entries: readonly HistoryEntry[],
  typed: string,
  key: (query: string) => string = libraryKey
): HistoryEntry[] {
  const words = queryWords(typed);
  const typedKey = typed.trim() ? key(typed) : null;
  return entries
    .filter((e) => (typedKey === null || key(e.query) !== typedKey) && matchesQuery(e.query, words))
    .sort(newestFirst);
}

/**
 * The reader's two groups: this book's searches, then other books' (one per search key,
 * the newest, leaving out searches already in this book), each newest first.
 */
export function groupForBook(
  entries: readonly HistoryEntry[],
  bookKey: string
): { thisBook: HistoryEntry[]; otherBooks: HistoryEntry[] } {
  const books = entries.filter((e) => e.scope === 'book').sort(newestFirst);
  const thisBook = books.filter((e) => e.book === bookKey);
  const seen = new Set(thisBook.map((e) => bookSearchKey(e.query)));
  const otherBooks: HistoryEntry[] = [];
  for (const e of books) {
    if (e.book === bookKey) continue;
    const k = bookSearchKey(e.query);
    if (seen.has(k)) continue;
    seen.add(k);
    otherBooks.push(e);
  }
  return { thisBook, otherBooks };
}

/** The oldest entries beyond `limit` (to remove). */
export function toPrune(entries: readonly HistoryEntry[], limit: number): HistoryEntry[] {
  const keep = Math.max(0, Math.floor(limit));
  return [...entries].sort(newestFirst).slice(keep);
}

/** The ids to remove so that the library and every book keep at most their limits. */
export function pruneIds(
  entries: readonly HistoryEntry[],
  limits: { library: number; perBook: number }
): string[] {
  const out = toPrune(
    entries.filter((e) => e.scope === 'lib'),
    limits.library
  ).map((e) => e.id);
  const byBook = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    if (e.scope !== 'book' || !e.book) continue;
    const list = byBook.get(e.book) ?? [];
    list.push(e);
    byBook.set(e.book, list);
  }
  for (const list of byBook.values()) {
    out.push(...toPrune(list, limits.perBook).map((e) => e.id));
  }
  return out;
}
