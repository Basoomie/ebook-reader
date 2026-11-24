/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Search history (2026-11-24): the synced records behind both lists. Best effort: nothing
 * here throws into a search or the reader (failures are logged, the list is then empty).
 * Writes go to the sync engine's IndexedDB mirror and outbox, so it works offline too.
 */

import { readable, type Readable } from 'svelte/store';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import {
  MAX_BOOK_SEARCH,
  MAX_LIBRARY_SEARCH,
  MAX_SEARCH_TITLE,
  SEARCH_HISTORY_KIND,
  bookRecordId,
  entryOf,
  libraryRecordId,
  localBookKey,
  pruneIds,
  type HistoryBook,
  type HistoryEntry,
  type HistoryScope
} from './search-history';

export interface SearchHistoryDeps {
  getEngine(): Promise<SyncEngine>;
  warn(message: string): void;
  /** The current limits (settings). */
  limits(): { library: number; perBook: number };
  now?(): number;
}

function message(error: unknown) {
  return (error as Error)?.message ?? String(error);
}

export async function loadEntries(deps: SearchHistoryDeps): Promise<HistoryEntry[]> {
  try {
    const engine = await deps.getEngine();
    const records = await engine.getAll(SEARCH_HISTORY_KIND);
    return records.map(entryOf).filter((e): e is HistoryEntry => e !== null);
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
    return [];
  }
}

async function prune(engine: SyncEngine, deps: SearchHistoryDeps) {
  const records = await engine.getAll(SEARCH_HISTORY_KIND);
  const entries = records.map(entryOf).filter((e): e is HistoryEntry => e !== null);
  for (const id of pruneIds(entries, deps.limits())) {
    await engine.remove(SEARCH_HISTORY_KIND, id);
  }
}

/** Remembers a library search (moves it to the top when already there). */
export async function recordLibrarySearch(query: string, deps: SearchHistoryDeps): Promise<void> {
  const text = query.trim();
  if (!text || text.length > MAX_LIBRARY_SEARCH) return;
  try {
    const engine = await deps.getEngine();
    const usedAt = (deps.now ?? Date.now)();
    await engine.put(SEARCH_HISTORY_KIND, libraryRecordId(text), { query: text, usedAt });
    await prune(engine, deps);
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
  }
}

/** Remembers a search in a book (moves it to the top of that book's list when there). */
export async function recordBookSearch(
  query: string,
  book: HistoryBook,
  deps: SearchHistoryDeps
): Promise<void> {
  const text = query.trim();
  if (!text || text.length > MAX_BOOK_SEARCH || !book.key) return;
  try {
    const engine = await deps.getEngine();
    const usedAt = (deps.now ?? Date.now)();
    const title = book.title.trim().slice(0, MAX_SEARCH_TITLE);
    await engine.put(SEARCH_HISTORY_KIND, bookRecordId(book.key, text), {
      query: text,
      book: book.key,
      title,
      usedAt
    });
    await prune(engine, deps);
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
  }
}

export async function removeEntry(id: string, deps: SearchHistoryDeps): Promise<void> {
  try {
    await (await deps.getEngine()).remove(SEARCH_HISTORY_KIND, id);
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
  }
}

/** Removes every search of one list (library, or every book's), on every device. */
export async function clearScope(scope: HistoryScope, deps: SearchHistoryDeps): Promise<void> {
  try {
    const engine = await deps.getEngine();
    for (const entry of await loadEntries(deps)) {
      if (entry.scope === scope) await engine.remove(SEARCH_HISTORY_KIND, entry.id);
    }
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
  }
}

/** Removes what is over the limits now (after a limit is lowered). */
export async function pruneNow(deps: SearchHistoryDeps): Promise<void> {
  try {
    await prune(await deps.getEngine(), deps);
  } catch (error) {
    deps.warn(`Search history: ${message(error)}`);
  }
}

/** The key of the open book: its server id, else local:<this device>:<local id>. */
export async function readerBookKey(
  serverBookId: string | null,
  localId: number,
  deps: SearchHistoryDeps
): Promise<string> {
  if (serverBookId) return serverBookId;
  try {
    return localBookKey((await deps.getEngine()).deviceId, localId);
  } catch {
    return '';
  }
}

/**
 * Every remembered search, kept current with local writes and pulls from other devices.
 * One listener pair for all subscribers; it starts with the first subscriber.
 */
export function historyStore(deps: SearchHistoryDeps): Readable<HistoryEntry[]> {
  return readable<HistoryEntry[]>([], (set) => {
    let stopped = false;
    let off: (() => void) | null = null;
    const refresh = () => {
      void loadEntries(deps).then((entries) => {
        if (!stopped) set(entries);
      });
    };
    refresh();
    void deps
      .getEngine()
      .then((engine) => {
        if (stopped) return;
        const relevant = (r: LocalRecord) => r.kind === SEARCH_HISTORY_KIND;
        const offRemote = engine.onRemoteChange((records) => {
          if (records.some(relevant)) refresh();
        });
        const offLocal = engine.onLocalWrite((r) => {
          if (relevant(r)) refresh();
        });
        off = () => {
          offRemote();
          offLocal();
        };
      })
      .catch(() => {});
    return () => {
      stopped = true;
      off?.();
    };
  });
}
