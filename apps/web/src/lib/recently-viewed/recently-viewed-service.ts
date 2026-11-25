/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Recently viewed (2026-11-24): the synced records behind the Home row and its page. Best
 * effort: nothing here throws into the book page (failures are logged, the list is then
 * empty). Writes go to the sync engine's IndexedDB mirror and outbox, so it works offline.
 */

import { readable, type Readable } from 'svelte/store';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import {
  RECENTLY_VIEWED_KIND,
  entryOf,
  trimIds,
  type Keep,
  type ViewedEntry
} from './recently-viewed';

export interface RecentlyViewedDeps {
  getEngine(): Promise<SyncEngine>;
  warn(message: string): void;
  keep(): Keep;
  now?(): number;
}

function message(error: unknown) {
  return (error as Error)?.message ?? String(error);
}

async function entriesOf(engine: SyncEngine): Promise<ViewedEntry[]> {
  const records = await engine.getAll(RECENTLY_VIEWED_KIND);
  return records.map(entryOf).filter((e): e is ViewedEntry => e !== null);
}

export async function loadViewed(deps: RecentlyViewedDeps): Promise<ViewedEntry[]> {
  try {
    return await entriesOf(await deps.getEngine());
  } catch (error) {
    deps.warn(`Recently viewed: ${message(error)}`);
    return [];
  }
}

async function trim(engine: SyncEngine, deps: RecentlyViewedDeps) {
  const now = (deps.now ?? Date.now)();
  for (const id of trimIds(await entriesOf(engine), deps.keep(), now)) {
    await engine.remove(RECENTLY_VIEWED_KIND, id);
  }
}

/** Remembers a view of a book (moves it to the front when already there). */
export async function recordView(bookId: string, deps: RecentlyViewedDeps): Promise<void> {
  if (!bookId) return;
  try {
    const engine = await deps.getEngine();
    const viewedAt = (deps.now ?? Date.now)();
    await engine.put(RECENTLY_VIEWED_KIND, bookId, { viewedAt });
    await trim(engine, deps);
  } catch (error) {
    deps.warn(`Recently viewed: ${message(error)}`);
  }
}

/** Removes books from the list, on every device. */
export async function removeViewed(
  bookIds: readonly string[],
  deps: RecentlyViewedDeps
): Promise<void> {
  try {
    const engine = await deps.getEngine();
    for (const id of bookIds) await engine.remove(RECENTLY_VIEWED_KIND, id);
  } catch (error) {
    deps.warn(`Recently viewed: ${message(error)}`);
  }
}

/** Removes every book from the list, on every device. */
export async function clearViewed(deps: RecentlyViewedDeps): Promise<void> {
  try {
    const engine = await deps.getEngine();
    for (const entry of await entriesOf(engine)) {
      await engine.remove(RECENTLY_VIEWED_KIND, entry.bookId);
    }
  } catch (error) {
    deps.warn(`Recently viewed: ${message(error)}`);
  }
}

/** Removes what the limit no longer keeps (a lowered limit, or days gone by). */
export async function trimNow(deps: RecentlyViewedDeps): Promise<void> {
  try {
    await trim(await deps.getEngine(), deps);
  } catch (error) {
    deps.warn(`Recently viewed: ${message(error)}`);
  }
}

/**
 * Every viewed book, kept current with local writes and pulls from other devices. One
 * listener pair for all subscribers; it starts with the first subscriber (and trims first,
 * so a list kept by days drops what has aged since the app last ran).
 */
export function viewedStore(deps: RecentlyViewedDeps): Readable<ViewedEntry[] | null> {
  return readable<ViewedEntry[] | null>(null, (set) => {
    let stopped = false;
    let off: (() => void) | null = null;
    const refresh = () => {
      void loadViewed(deps).then((entries) => {
        if (!stopped) set(entries);
      });
    };
    void trimNow(deps).then(refresh);
    void deps
      .getEngine()
      .then((engine) => {
        if (stopped) return;
        const relevant = (r: LocalRecord) => r.kind === RECENTLY_VIEWED_KIND;
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
