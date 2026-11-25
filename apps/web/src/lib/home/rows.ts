/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { builtinCollection } from '$lib/collections/builtins';
import type { Collection } from '$lib/collections/collections';
import type { BookListQuery } from '$lib/library/api';

/**
 * Home rows (WP7b, decided with the user): per device, customizable. Anything can be
 * pinned (a collection, a built-in list, a series, an author or a tag); rows can be
 * reordered and hidden. Continue Reading is the default first row; "Recently added"
 * is optional and hidden by default, and so is "Recently viewed" (2026-11-24: books whose
 * details page you looked at). Stored as the per-device setting `homeRows`.
 */
export type GroupRowType = 'series' | 'author' | 'tag';

export type PinTarget =
  | { type: 'builtin'; ref: string }
  | { type: 'collection'; ref: string }
  | { type: GroupRowType; ref: string };

export type HomeRow =
  | { type: 'continue'; hidden: boolean }
  | { type: 'recent'; hidden: boolean }
  | { type: 'viewed'; hidden: boolean }
  | (PinTarget & { hidden: boolean });

export const DEFAULT_HOME_ROWS: readonly HomeRow[] = [
  { type: 'continue', hidden: false },
  { type: 'recent', hidden: true },
  { type: 'viewed', hidden: true }
];

const PINNABLE = new Set(['builtin', 'collection', 'series', 'author', 'tag']);

export function rowKey(row: { type: string; ref?: string }): string {
  return row.ref === undefined ? row.type : `${row.type}:${row.ref}`;
}

/** A pinned row (as opposed to Continue Reading, Recently added and Recently viewed, which can only be hidden). */
export function isPinnedRow(row: HomeRow): row is PinTarget & { hidden: boolean } {
  return PINNABLE.has(row.type);
}

function parseRow(raw: unknown): HomeRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; ref?: unknown; hidden?: unknown };
  const hidden = r.hidden === true;
  if (r.type === 'continue' || r.type === 'recent' || r.type === 'viewed') {
    return { type: r.type, hidden };
  }
  if (typeof r.type !== 'string' || !PINNABLE.has(r.type)) return null;
  if (typeof r.ref !== 'string' || r.ref === '') return null;
  if (r.type === 'builtin' && !builtinCollection(r.ref)) return null;
  return { type: r.type as PinTarget['type'], ref: r.ref, hidden } as HomeRow;
}

/**
 * The stored rows, cleaned up: unreadable and repeated entries are dropped, and
 * Continue Reading, Recently added and Recently viewed are always there (added with their
 * defaults).
 */
export function normalizeRows(raw: unknown): HomeRow[] {
  const out: HomeRow[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const row = parseRow(entry);
    if (!row || seen.has(rowKey(row))) continue;
    seen.add(rowKey(row));
    out.push(row);
  }
  if (!seen.has('continue')) out.unshift({ type: 'continue', hidden: false });
  if (!seen.has('recent')) out.push({ type: 'recent', hidden: true });
  if (!seen.has('viewed')) out.push({ type: 'viewed', hidden: true });
  return out;
}

export function isPinned(rows: readonly HomeRow[], target: PinTarget): boolean {
  const key = rowKey(target);
  return rows.some((r) => rowKey(r) === key && !r.hidden);
}

/** Pins a row at the end (a hidden one with the same target is shown again in place). */
export function pinRow(rows: readonly HomeRow[], target: PinTarget): HomeRow[] {
  const key = rowKey(target);
  if (rows.some((r) => rowKey(r) === key)) {
    return rows.map((r) => (rowKey(r) === key ? { ...r, hidden: false } : r));
  }
  return [...rows, { ...target, hidden: false } as HomeRow];
}

export function unpinRow(rows: readonly HomeRow[], target: PinTarget): HomeRow[] {
  const key = rowKey(target);
  return rows.filter((r) => rowKey(r) !== key);
}

/** Undo of a removal (WP19): the row goes back to its old place, or last; once only. */
export function restoreRow(rows: readonly HomeRow[], row: HomeRow, index: number): HomeRow[] {
  const key = rowKey(row);
  if (rows.some((r) => rowKey(r) === key)) return [...rows];
  const out = [...rows];
  out.splice(Math.min(Math.max(0, index), out.length), 0, row);
  return out;
}

export function moveRow(rows: readonly HomeRow[], index: number, delta: number): HomeRow[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  const [row] = out.splice(index, 1);
  out.splice(to, 0, row);
  return out;
}

export function setRowHidden(rows: readonly HomeRow[], index: number, hidden: boolean): HomeRow[] {
  return rows.map((r, i) => (i === index ? { ...r, hidden } : r));
}

/** A row's title on Home (collections are named by the caller, which knows their names). */
export function rowTitle(row: HomeRow, collectionName?: (id: string) => string | null): string {
  switch (row.type) {
    case 'continue':
      return 'Continue reading';
    case 'recent':
      return 'Recently added';
    case 'viewed':
      return 'Recently viewed';
    case 'builtin':
      return builtinCollection(row.ref)?.name ?? row.ref;
    case 'collection':
      return collectionName?.(row.ref) ?? 'Deleted collection';
    default:
      return row.ref;
  }
}

/**
 * Where a row's "See all" goes. Continue reading goes to the Reading collection: books
 * get that status when they are opened, so it holds the same books, all of them. A
 * collection or a group opened from Home carries `from=home`: its back link goes to Home.
 */
export function rowHref(row: HomeRow, base: string): string | null {
  const q = (params: Record<string, string>) =>
    `${base}/library?${new URLSearchParams({ ...params, from: 'home' })}`;
  switch (row.type) {
    case 'continue':
      return q({ collection: 'reading' });
    case 'recent':
      return `${base}/library`;
    case 'viewed':
      return `${base}/recently-viewed`;
    case 'builtin':
    case 'collection':
      return q({ collection: row.ref });
    case 'series':
      return q({ tab: 'series', group: row.ref });
    case 'author':
      return q({ tab: 'authors', group: row.ref });
    case 'tag':
      return q({ tab: 'tags', group: row.ref });
  }
}

/**
 * A row's whole list as a server book count (the number beside the row's title), so the
 * number is what "See all" shows: Recently added counts the whole library. Null for
 * Continue reading, which is counted from its own list (every book you are partway
 * through, from this device's mirror: more than the books marked Reading), and when there
 * is nothing to count (a deleted collection, a smart collection without a search).
 */
export function rowCountQuery(
  row: HomeRow,
  collection?: Pick<Collection, 'id' | 'type' | 'query'> | null
): BookListQuery | null {
  switch (row.type) {
    case 'continue':
    case 'viewed':
      return null;
    case 'recent':
      return {};
    case 'builtin': {
      const b = builtinCollection(row.ref);
      return b ? { scope: b.query } : null;
    }
    case 'collection':
      if (!collection || collection.id !== row.ref) return null;
      if (collection.type === 'manual') return { collection: collection.id };
      return collection.query ? { scope: collection.query } : null;
    default:
      return { group: { by: row.type, name: row.ref } };
  }
}
