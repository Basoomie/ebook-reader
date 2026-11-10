/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { parseQuery, QUERY_LIMITS } from '$lib/library/query/parse';
import type { LocalRecord } from '$lib/sync/sync-db';
import { evenKeys, isOrderKey, keyBetween, REBALANCE_LENGTH, type Random } from './order-key';

/**
 * Collections (WP8b), as records:
 * - "collection": id = a UUID, data { name, type: 'manual' | 'smart', query? }.
 * - "collection-item": id = <collectionId>:<bookId>, data { key }: one per book of a
 *   manual collection, ordered by `key` (order-key.ts), then by book id.
 * A smart collection is a search, evaluated by the server
 * each time. Built-in collections are not records (builtins.ts).
 */
export const COLLECTION_KIND = 'collection';
export const COLLECTION_ITEM_KIND = 'collection-item';
export const MAX_NAME_LENGTH = 200;

export type CollectionType = 'manual' | 'smart';

export interface Collection {
  id: string;
  name: string;
  type: CollectionType;
  /** Smart collections only. */
  query: string | null;
  updatedAt: number;
}

export interface CollectionItem {
  collectionId: string;
  bookId: string;
  key: string;
}

export function itemRecordId(collectionId: string, bookId: string): string {
  return `${collectionId}:${bookId}`;
}

export function parseItemId(id: string): { collectionId: string; bookId: string } | null {
  const parts = id.split(':');
  return parts.length === 2 && parts[0] && parts[1]
    ? { collectionId: parts[0], bookId: parts[1] }
    : null;
}

function collectionFrom(r: LocalRecord): Collection | null {
  if (r.kind !== COLLECTION_KIND || r.deletedAt !== null) return null;
  const name = typeof r.data?.name === 'string' ? r.data.name : '';
  const type = r.data?.type === 'smart' ? 'smart' : r.data?.type === 'manual' ? 'manual' : null;
  if (!name || !type) return null;
  const query = type === 'smart' && typeof r.data?.query === 'string' ? r.data.query : null;
  return { id: r.id, name, type, query, updatedAt: r.updatedAt };
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function compareByName(a: { name: string; id: string }, b: { name: string; id: string }) {
  return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Live collections, by name. */
export function collectionsFrom(records: readonly LocalRecord[]): Collection[] {
  return records
    .map(collectionFrom)
    .filter((c): c is Collection => c !== null)
    .sort(compareByName);
}

export function compareItems(a: CollectionItem, b: CollectionItem): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0;
}

/** Every live item, grouped by collection and in order. */
export function itemsByCollection(records: readonly LocalRecord[]): Map<string, CollectionItem[]> {
  const out = new Map<string, CollectionItem[]>();
  for (const r of records) {
    if (r.kind !== COLLECTION_ITEM_KIND || r.deletedAt !== null) continue;
    const parsed = parseItemId(r.id);
    const key = r.data?.key;
    if (!parsed || !isOrderKey(key)) continue;
    const list = out.get(parsed.collectionId) ?? [];
    list.push({ ...parsed, key });
    out.set(parsed.collectionId, list);
  }
  for (const list of out.values()) list.sort(compareItems);
  return out;
}

export function checkName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Type a name.';
  if (trimmed.length > MAX_NAME_LENGTH) return `At most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

/** The parser's message for a search that can't be saved, or null. */
export function checkQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return 'Type a search.';
  if (trimmed.length > QUERY_LIMITS.maxLength) {
    return `At most ${QUERY_LIMITS.maxLength} characters.`;
  }
  const result = parseQuery(trimmed);
  return result.ok ? null : result.error.message;
}

export interface KeyWrite {
  bookId: string;
  key: string;
}

/**
 * Keys that put `bookIds` (in that order) at `index` of `others` (the collection's
 * other books, in order). Usually one write per moved book. Equal neighbour keys are
 * separated first (the books after the gap get new keys too), and when keys get long
 * the whole collection gets fresh ones.
 */
export function placeAt(
  others: readonly CollectionItem[],
  bookIds: readonly string[],
  index: number,
  random: Random = Math.random
): KeyWrite[] {
  if (bookIds.length === 0) return [];
  const at = Math.max(0, Math.min(index, others.length));
  const prev = at > 0 ? others[at - 1].key : null;
  // The first key after the gap that is greater than prev; equal ones in between
  // must move behind the placed books.
  let j = at;
  while (prev !== null && j < others.length && others[j].key <= prev) j++;
  const next = j < others.length ? others[j].key : null;
  const writes: KeyWrite[] = [];
  let last = prev;
  for (const bookId of bookIds) {
    last = keyBetween(last, next, random);
    writes.push({ bookId, key: last });
  }
  for (const item of others.slice(at, j)) {
    last = keyBetween(last, next, random);
    writes.push({ bookId: item.bookId, key: last });
  }
  if (writes.some((w) => w.key.length > REBALANCE_LENGTH)) {
    const order = [
      ...others.slice(0, at).map((i) => i.bookId),
      ...bookIds,
      ...others.slice(at).map((i) => i.bookId)
    ];
    const keys = evenKeys(order.length);
    return order.map((bookId, i) => ({ bookId, key: keys[i] }));
  }
  return writes;
}
