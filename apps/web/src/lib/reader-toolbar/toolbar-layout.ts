/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Reader toolbars session 1 (docs/design/reader-toolbar.md): the reader's top bar and the
 * left side of its bottom bar are built from two per-device lists, `readerToolbar` and
 * `readerBottomBar` (lib/data/store.ts). This file holds their ids, defaults and rules; it
 * imports no stores so it can be tested on its own.
 *
 * A stored list is kept exactly as stored (a copy from another device stores its exact
 * string); what the bars show is always `resolveTopBar` / `resolveBottomBar` of it.
 */

export type TopPlace = 'bar' | 'menu' | 'hidden';

export interface TopEntry {
  id: TopId;
  place: TopPlace;
}

export interface BottomEntry {
  id: BottomId;
  shown: boolean;
}

/**
 * The top bar's defaults: the user's PC answers (reader-toolbar.md, "Defaults"), plus the
 * speed readout and the gap where they sit today (decided with the user 2026-11-21).
 *
 * A button added in a later version goes at the END of this list as `hidden` (decision 7),
 * so no device's bar changes on its own.
 */
export const TOP_DEFAULT: readonly TopEntry[] = Object.freeze([
  { id: 'toc', place: 'bar' },
  { id: 'appearance', place: 'bar' },
  { id: 'search', place: 'bar' },
  { id: 'notes', place: 'bar' },
  { id: 'jumpBackForward', place: 'bar' },
  { id: 'returnMarker', place: 'bar' },
  { id: 'speed', place: 'bar' },
  { id: 'gap', place: 'bar' },
  { id: 'images', place: 'bar' },
  { id: 'jump', place: 'bar' },
  { id: 'addBookmark', place: 'bar' },
  { id: 'pacer', place: 'bar' },
  { id: 'readAloud', place: 'bar' },
  { id: 'shortcuts', place: 'bar' },
  { id: 'fullscreen', place: 'bar' },
  { id: 'settings', place: 'bar' },
  { id: 'home', place: 'bar' },
  { id: 'menu', place: 'bar' },
  { id: 'savePlace', place: 'hidden' },
  { id: 'returnToSaved', place: 'hidden' },
  { id: 'readingPoint', place: 'hidden' },
  { id: 'completeBook', place: 'hidden' },
  { id: 'statistics', place: 'hidden' },
  { id: 'ankiEnrich', place: 'hidden' },
  { id: 'bookStatus', place: 'hidden' },
  { id: 'addToCollection', place: 'hidden' },
  { id: 'zen', place: 'hidden' },
  { id: 'library', place: 'hidden' }
] as const satisfies readonly { id: string; place: TopPlace }[]);

export type TopId =
  | 'toc'
  | 'appearance'
  | 'search'
  | 'notes'
  | 'jumpBackForward'
  | 'returnMarker'
  | 'speed'
  | 'gap'
  | 'images'
  | 'jump'
  | 'addBookmark'
  | 'pacer'
  | 'readAloud'
  | 'shortcuts'
  | 'fullscreen'
  | 'settings'
  | 'home'
  | 'menu'
  | 'savePlace'
  | 'returnToSaved'
  | 'readingPoint'
  | 'completeBook'
  | 'statistics'
  | 'ankiEnrich'
  | 'bookStatus'
  | 'addToCollection'
  | 'zen'
  | 'library';

export const TOP_IDS: readonly TopId[] = TOP_DEFAULT.map(({ id }) => id);

/** Entries that are never menu entries (the menu button itself, the readout, the gap). */
export const BAR_ONLY_IDS: ReadonlySet<TopId> = new Set<TopId>(['menu', 'speed', 'gap']);

/** The bottom bar's left side, in today's order with the old defaults (nothing changes). */
export const BOTTOM_DEFAULT: readonly BottomEntry[] = Object.freeze([
  { id: 'tracker', shown: true },
  { id: 'anki', shown: false },
  { id: 'pacer', shown: true },
  { id: 'readAloud', shown: false },
  { id: 'returnMarker', shown: false },
  { id: 'audiobook', shown: true }
] as const satisfies readonly { id: string; shown: boolean }[]);

export type BottomId = 'tracker' | 'anki' | 'pacer' | 'readAloud' | 'returnMarker' | 'audiobook';

export const BOTTOM_IDS: readonly BottomId[] = BOTTOM_DEFAULT.map(({ id }) => id);

const TOP_ID_SET = new Set<string>(TOP_IDS);
const BOTTOM_ID_SET = new Set<string>(BOTTOM_IDS);
const PLACES = new Set<string>(['bar', 'menu', 'hidden']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * What the top bar shows from a stored list: known ids in stored order (an id counts the
 * first time it appears), unknown ids and invalid places ignored, and every known id the
 * list lacks added at the end as hidden (decision 7). Anything but an array reads as the
 * defaults. The menu button, the readout and the gap are never menu entries: 'menu' reads
 * as 'bar' for them.
 */
export function resolveTopBar(stored: unknown): TopEntry[] {
  if (!Array.isArray(stored)) {
    return TOP_DEFAULT.map((entry) => ({ ...entry }));
  }

  const seen = new Set<TopId>();
  const result: TopEntry[] = [];

  for (const item of stored) {
    if (!isRecord(item)) continue;
    const { id, place } = item;
    if (typeof id !== 'string' || !TOP_ID_SET.has(id) || seen.has(id as TopId)) continue;
    if (typeof place !== 'string' || !PLACES.has(place)) continue;
    const topId = id as TopId;
    seen.add(topId);
    result.push({
      id: topId,
      place: place === 'menu' && BAR_ONLY_IDS.has(topId) ? 'bar' : (place as TopPlace)
    });
  }

  for (const id of TOP_IDS) {
    if (!seen.has(id)) result.push({ id, place: 'hidden' });
  }

  return result;
}

/** The bottom bar's left side from a stored list (same rules as the top bar). */
export function resolveBottomBar(stored: unknown): BottomEntry[] {
  if (!Array.isArray(stored)) {
    return BOTTOM_DEFAULT.map((entry) => ({ ...entry }));
  }

  const seen = new Set<BottomId>();
  const result: BottomEntry[] = [];

  for (const item of stored) {
    if (!isRecord(item)) continue;
    const { id, shown } = item;
    if (typeof id !== 'string' || !BOTTOM_ID_SET.has(id) || seen.has(id as BottomId)) continue;
    if (typeof shown !== 'boolean') continue;
    seen.add(id as BottomId);
    result.push({ id: id as BottomId, shown });
  }

  for (const id of BOTTOM_IDS) {
    if (!seen.has(id)) result.push({ id, shown: false });
  }

  return result;
}

/**
 * The top-bar entries in list order that are placed in the bar (`bar`) or the menu (`menu`)
 * and whose condition holds now. The menu button is kept only when the menu has at least
 * one entry to show, so it never opens an empty menu.
 */
export function visibleTopBar(
  entries: readonly TopEntry[],
  available: (id: TopId) => boolean
): { bar: TopId[]; menu: TopId[] } {
  const menu = entries
    .filter(({ id, place }) => place === 'menu' && !BAR_ONLY_IDS.has(id) && available(id))
    .map(({ id }) => id);
  const bar = entries
    .filter(({ id, place }) => place === 'bar' && (id === 'menu' ? menu.length > 0 : available(id)))
    .map(({ id }) => id);

  return { bar, menu };
}

/** The three bottom-bar switches that were separate settings before session 1. */
export const OLD_BOTTOM_BAR_KEYS = {
  anki: 'ankiBottomBarButton',
  readAloud: 'readAloudBottomBarButton',
  returnMarker: 'showReturnMarker'
} as const satisfies Partial<Record<BottomId, string>>;

export const READER_BOTTOM_BAR_KEY = 'readerBottomBar';

interface MigrationStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Session 1's upgrade: a device's three old switches become the `shown` of their entries in
 * `readerBottomBar` (today's order), so nothing visible changes. Runs once: only while
 * `readerBottomBar` isn't stored and at least one old key is (an unset key keeps its old
 * default, off). The old keys are then removed: they were moved, and a later copy from a
 * device that never stored `readerBottomBar` must not bring them back into play.
 *
 * @returns whether anything was migrated.
 */
export function migrateBottomBarSwitches(storage: MigrationStorage): boolean {
  try {
    if (storage.getItem(READER_BOTTOM_BAR_KEY) != null) return false;

    const entries = Object.entries(OLD_BOTTOM_BAR_KEYS) as [BottomId, string][];
    const stored = entries.map(([id, key]) => [id, storage.getItem(key)] as const);

    if (stored.every(([, raw]) => !raw)) return false;

    const values = new Map(stored);
    const list = BOTTOM_DEFAULT.map(({ id, shown }) => {
      const raw = values.get(id);
      // Same reading as the boolean subjects: '1'/'0', empty = never set.
      return { id, shown: raw ? !!+raw : shown };
    });

    storage.setItem(READER_BOTTOM_BAR_KEY, JSON.stringify(list));
    for (const [, key] of entries) storage.removeItem(key);
    return true;
  } catch {
    // Storage unavailable: the defaults apply, as for any setting.
    return false;
  }
}
