/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The reader's own reloads (whispersync's "Newer audiobook data" notice) come back to the
 * page that was showing, even when it wasn't saved ("Only save my place by hand"). The
 * place is kept in this tab's sessionStorage and used once, on the next open of the same
 * book. Nothing here throws: blocked or missing storage means a plain reload.
 */

export const RELOAD_PLACE_KEY = 'ttu-reader-reload-place';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's sessionStorage, or undefined where reading it throws (blocked site data). */
export function tabStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function keepPlaceForReload(
  storage: StorageLike | undefined,
  localId: number,
  exploredCharCount: number
): void {
  try {
    if (!storage || !Number.isFinite(exploredCharCount)) return;
    storage.setItem(
      RELOAD_PLACE_KEY,
      JSON.stringify({ localId, exploredCharCount: Math.max(0, exploredCharCount) })
    );
  } catch {
    // a plain reload
  }
}

/** The place kept for this book (removed either way), or null. */
export function takePlaceAfterReload(
  storage: StorageLike | undefined,
  localId: number
): number | null {
  try {
    if (!storage) return null;
    const raw = storage.getItem(RELOAD_PLACE_KEY);
    if (raw === null) return null;
    storage.removeItem(RELOAD_PLACE_KEY);
    const kept = JSON.parse(raw) as { localId?: unknown; exploredCharCount?: unknown };
    const place = kept?.exploredCharCount;
    if (kept?.localId !== localId || typeof place !== 'number' || !Number.isFinite(place)) {
      return null;
    }
    return Math.max(0, place);
  } catch {
    return null;
  }
}
