/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { randomId } from '$lib/functions/secure-context';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import {
  checkName,
  checkQuery,
  COLLECTION_ITEM_KIND,
  COLLECTION_KIND,
  collectionsFrom,
  itemRecordId,
  itemsByCollection,
  parseItemId,
  placeAt,
  type Collection,
  type CollectionItem,
  type CollectionType,
  type KeyWrite
} from './collections';
import type { Random } from './order-key';

/**
 * Collections (WP8b) on top of the sync engine: reads come from the local mirror (work
 * offline, show local changes at once), writes are local records queued for the server.
 * User actions throw CollectionError when something could not be saved; bulk actions
 * save book by book and return the ids that failed. Nothing here touches stat-day or
 * position records.
 */

export interface CollectionsDeps {
  getEngine(): Promise<SyncEngine>;
  warn(message: string): void;
  /** For tests (order keys are picked at random). */
  random?: Random;
  newId?: () => string;
}

export class CollectionError extends Error {}

export interface CollectionsView {
  collections: Collection[];
  /** Live items of live collections, in order. */
  items: Map<string, CollectionItem[]>;
}

export function viewFrom(
  collectionRecords: readonly LocalRecord[],
  itemRecords: readonly LocalRecord[]
): CollectionsView {
  const collections = collectionsFrom(collectionRecords);
  const live = new Set(collections.map((c) => c.id));
  const items = itemsByCollection(itemRecords);
  for (const id of [...items.keys()]) if (!live.has(id)) items.delete(id);
  return { collections, items };
}

export async function getCollectionsView(deps: CollectionsDeps): Promise<CollectionsView> {
  const engine = await deps.getEngine();
  const [collections, items] = await Promise.all([
    engine.getAll(COLLECTION_KIND),
    engine.getAll(COLLECTION_ITEM_KIND)
  ]);
  return viewFrom(collections, items);
}

/** The ids of the manual collections a book is in. */
export async function collectionsOfBook(
  bookId: string,
  deps: CollectionsDeps
): Promise<Set<string>> {
  const engine = await deps.getEngine();
  const out = new Set<string>();
  for (const r of await engine.getForBook(bookId)) {
    if (r.kind !== COLLECTION_ITEM_KIND || r.deletedAt !== null) continue;
    const parsed = parseItemId(r.id);
    if (parsed) out.add(parsed.collectionId);
  }
  return out;
}

async function liveCollection(engine: SyncEngine, id: string): Promise<LocalRecord> {
  const record = await engine.get(COLLECTION_KIND, id);
  if (!record || record.deletedAt !== null) throw new CollectionError('This collection is gone.');
  return record;
}

async function itemsOf(engine: SyncEngine, collectionId: string): Promise<CollectionItem[]> {
  return itemsByCollection(await engine.getAll(COLLECTION_ITEM_KIND)).get(collectionId) ?? [];
}

async function writeKeys(
  engine: SyncEngine,
  collectionId: string,
  writes: readonly KeyWrite[],
  deps: CollectionsDeps
): Promise<string[]> {
  const failed: string[] = [];
  for (const w of writes) {
    const ok = await engine.put(
      COLLECTION_ITEM_KIND,
      itemRecordId(collectionId, w.bookId),
      { key: w.key },
      { bookId: w.bookId }
    );
    if (!ok) {
      deps.warn(`Collections: could not save the place of ${w.bookId}`);
      failed.push(w.bookId);
    }
  }
  return failed;
}

// ---- collections ------------------------------------------------------------

export async function createCollection(
  input: { name: string; type: CollectionType; query?: string | null },
  deps: CollectionsDeps
): Promise<string> {
  const problem =
    checkName(input.name) ?? (input.type === 'smart' ? checkQuery(input.query ?? '') : null);
  if (problem) throw new CollectionError(problem);
  const engine = await deps.getEngine();
  const id = (deps.newId ?? randomId)();
  const data: Record<string, unknown> = { name: input.name.trim(), type: input.type };
  if (input.type === 'smart') data.query = (input.query ?? '').trim();
  if (!(await engine.put(COLLECTION_KIND, id, data, { bookId: null }))) {
    throw new CollectionError('Could not save the collection.');
  }
  return id;
}

async function updateCollection(
  id: string,
  change: (data: Record<string, unknown>) => void,
  deps: CollectionsDeps
): Promise<void> {
  const engine = await deps.getEngine();
  const record = await liveCollection(engine, id);
  const data = { ...record.data };
  change(data);
  if (!(await engine.put(COLLECTION_KIND, id, data, { bookId: null }))) {
    throw new CollectionError('Could not save the collection.');
  }
}

export function renameCollection(id: string, name: string, deps: CollectionsDeps) {
  const problem = checkName(name);
  if (problem) return Promise.reject(new CollectionError(problem));
  return updateCollection(id, (d) => (d.name = name.trim()), deps);
}

export function setCollectionQuery(id: string, query: string, deps: CollectionsDeps) {
  const problem = checkQuery(query);
  if (problem) return Promise.reject(new CollectionError(problem));
  return updateCollection(
    id,
    (d) => {
      if (d.type !== 'smart') throw new CollectionError('Only a saved search has a search.');
      d.query = query.trim();
    },
    deps
  );
}

/** Deletes the collection and takes its books out of it (the books themselves stay). */
export async function deleteCollection(id: string, deps: CollectionsDeps): Promise<void> {
  const engine = await deps.getEngine();
  await liveCollection(engine, id);
  if (!(await engine.remove(COLLECTION_KIND, id))) {
    throw new CollectionError('Could not delete the collection.');
  }
  // Best effort: items of a deleted collection are hidden anyway.
  for (const item of await itemsOf(engine, id)) {
    await engine.remove(COLLECTION_ITEM_KIND, itemRecordId(id, item.bookId));
  }
}

// ---- books in a manual collection --------------------------------------------

async function manual(engine: SyncEngine, id: string): Promise<void> {
  const record = await liveCollection(engine, id);
  if (record.data?.type !== 'manual') {
    throw new CollectionError('Books are added to a list, not to a saved search.');
  }
}

/**
 * Adds books at the end, in the given order. Books already in it keep their place.
 * Returns the ids that could not be saved.
 */
export async function addBooks(
  collectionId: string,
  bookIds: readonly string[],
  deps: CollectionsDeps
): Promise<string[]> {
  const engine = await deps.getEngine();
  await manual(engine, collectionId);
  const items = await itemsOf(engine, collectionId);
  const present = new Set(items.map((i) => i.bookId));
  const fresh = [...new Set(bookIds)].filter((id) => !present.has(id));
  return writeKeys(engine, collectionId, placeAt(items, fresh, items.length, deps.random), deps);
}

/** Returns the ids that could not be saved. */
export async function removeBooks(
  collectionId: string,
  bookIds: readonly string[],
  deps: CollectionsDeps
): Promise<string[]> {
  const engine = await deps.getEngine();
  const present = new Set((await itemsOf(engine, collectionId)).map((i) => i.bookId));
  const failed: string[] = [];
  for (const bookId of new Set(bookIds)) {
    if (!present.has(bookId)) continue;
    if (!(await engine.remove(COLLECTION_ITEM_KIND, itemRecordId(collectionId, bookId)))) {
      failed.push(bookId);
    }
  }
  return failed;
}

/**
 * Moves books (in the given order) so the first lands at `index` of the collection
 * without them (0 = top). Returns the ids that could not be saved.
 */
export async function moveBooks(
  collectionId: string,
  bookIds: readonly string[],
  index: number,
  deps: CollectionsDeps
): Promise<string[]> {
  const engine = await deps.getEngine();
  await manual(engine, collectionId);
  const items = await itemsOf(engine, collectionId);
  const moving = new Set(bookIds);
  const ordered = items.filter((i) => moving.has(i.bookId)).map((i) => i.bookId);
  // Keep the caller's order (e.g. the selection order on screen).
  const wanted = [...new Set(bookIds)].filter((id) => ordered.includes(id));
  const others = items.filter((i) => !moving.has(i.bookId));
  return writeKeys(engine, collectionId, placeAt(others, wanted, index, deps.random), deps);
}

/** One step up (-1) or down (+1). Returns the ids that could not be saved. */
export async function moveBookBy(
  collectionId: string,
  bookId: string,
  delta: -1 | 1,
  deps: CollectionsDeps
): Promise<string[]> {
  const engine = await deps.getEngine();
  const items = await itemsOf(engine, collectionId);
  const from = items.findIndex((i) => i.bookId === bookId);
  if (from === -1) return [];
  const to = from + delta;
  if (to < 0 || to >= items.length) return [];
  return moveBooks(collectionId, [bookId], to, deps);
}

/** Called after local writes or pulls of collection records. */
export async function onCollectionsChanged(
  callback: () => void,
  deps: CollectionsDeps
): Promise<() => void> {
  try {
    const engine = await deps.getEngine();
    const relevant = (r: LocalRecord) =>
      r.kind === COLLECTION_KIND || r.kind === COLLECTION_ITEM_KIND;
    const offRemote = engine.onRemoteChange((records) => {
      if (records.some(relevant)) callback();
    });
    const offLocal = engine.onLocalWrite((r) => {
      if (relevant(r)) callback();
    });
    return () => {
      offRemote();
      offLocal();
    };
  } catch {
    return () => {};
  }
}
