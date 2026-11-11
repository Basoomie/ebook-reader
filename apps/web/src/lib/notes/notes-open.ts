/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP19d: which books are opened on the Notes page, remembered on this device only (a
 * view preference, not a record). Storage can be missing or throw (private windows,
 * blocked site data): then every book simply starts collapsed.
 */

export const NOTES_OPEN_KEY = 'ttu-notes-open';
/** Oldest entries are dropped beyond this (books whose highlights are long gone). */
export const NOTES_OPEN_MAX = 500;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadOpenBooks(storage: Storage | undefined = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(NOTES_OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set();
  }
}

export function saveOpenBooks(
  open: ReadonlySet<string>,
  storage: Storage | undefined = defaultStorage()
): void {
  try {
    storage?.setItem(NOTES_OPEN_KEY, JSON.stringify([...open].slice(-NOTES_OPEN_MAX)));
  } catch {
    // Not remembered on this device; the page works the same.
  }
}
