/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Next in your series: the hidden series (synced "series-next-hide" records, one per series
 * in a library). Best effort: reads never reject (empty on failure); writes go to the sync
 * engine's mirror and outbox, so they work offline.
 */

import { readable, type Readable } from 'svelte/store';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import { SERIES_NEXT_HIDE_KIND, hiddenOf, hideRecordId, type HiddenSeries } from './next-in-series';

export interface NextInSeriesDeps {
  getEngine(): Promise<SyncEngine>;
  warn(message: string): void;
  now?(): number;
}

function message(error: unknown) {
  return (error as Error)?.message ?? String(error);
}

export async function loadHidden(deps: NextInSeriesDeps): Promise<HiddenSeries[]> {
  try {
    const engine = await deps.getEngine();
    return (await engine.getAll(SERIES_NEXT_HIDE_KIND))
      .map(hiddenOf)
      .filter((h): h is HiddenSeries => h !== null)
      .sort((a, b) => b.hiddenAt - a.hiddenAt);
  } catch (error) {
    deps.warn(`Next in your series: ${message(error)}`);
    return [];
  }
}

/** Hides a series of a library from Next in your series, on every device. */
export async function hideSeries(
  libraryId: string,
  name: string,
  deps: NextInSeriesDeps
): Promise<void> {
  const engine = await deps.getEngine();
  await engine.put(SERIES_NEXT_HIDE_KIND, hideRecordId(libraryId, name), {
    library: libraryId,
    name,
    hiddenAt: (deps.now ?? Date.now)()
  });
}

/** Shows a hidden series again. */
export async function showSeries(
  libraryId: string,
  name: string,
  deps: NextInSeriesDeps
): Promise<void> {
  const engine = await deps.getEngine();
  await engine.remove(SERIES_NEXT_HIDE_KIND, hideRecordId(libraryId, name));
}

/** The hidden series, kept current with local writes and pulls from other devices. */
export function hiddenStore(deps: NextInSeriesDeps): Readable<HiddenSeries[] | null> {
  return readable<HiddenSeries[] | null>(null, (set) => {
    let stopped = false;
    let off: (() => void) | null = null;
    const refresh = () => {
      void loadHidden(deps).then((list) => {
        if (!stopped) set(list);
      });
    };
    refresh();
    void deps
      .getEngine()
      .then((engine) => {
        if (stopped) return;
        const relevant = (r: LocalRecord) => r.kind === SERIES_NEXT_HIDE_KIND;
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
