/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Reader toolbars session 2: the edits of Settings > Reader > Toolbars. Each takes the stored
 * value (anything: a copy from another device, an old list, nothing), works on what the bar
 * shows of it (`resolveTopBar` / `resolveBottomBar`) and returns the new full list to store.
 * No stores here, so it can be tested on its own.
 */

import {
  BAR_ONLY_IDS,
  BOTTOM_DEFAULT,
  TOP_DEFAULT,
  resolveBottomBar,
  resolveTopBar,
  type BottomEntry,
  type BottomId,
  type TopEntry,
  type TopId,
  type TopPlace
} from './toolbar-layout';

function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return list;
  }
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** The places a top-bar entry can take: the menu button, the readout and the gap never go in the menu. */
export function topChoices(id: TopId): TopPlace[] {
  return BAR_ONLY_IDS.has(id) ? ['bar', 'hidden'] : ['bar', 'menu', 'hidden'];
}

/** One step up (-1) or down (+1); nothing happens at the ends. */
export function moveTop(stored: unknown, id: TopId, delta: -1 | 1): TopEntry[] {
  const list = resolveTopBar(stored);
  const from = list.findIndex((entry) => entry.id === id);
  return moveIndex(list, from, from + delta);
}

/** A drop: the entry at `from` goes to `to` (indexes in the shown list). */
export function moveTopTo(stored: unknown, from: number, to: number): TopEntry[] {
  return moveIndex(resolveTopBar(stored), from, to);
}

/** Bar, Menu or Hidden; Menu is refused for the entries that are never menu entries. */
export function setTopPlace(stored: unknown, id: TopId, place: TopPlace): TopEntry[] {
  const list = resolveTopBar(stored);
  if (!topChoices(id).includes(place)) return list;
  return list.map((entry) => (entry.id === id ? { ...entry, place } : entry));
}

export function moveBottom(stored: unknown, id: BottomId, delta: -1 | 1): BottomEntry[] {
  const list = resolveBottomBar(stored);
  const from = list.findIndex((entry) => entry.id === id);
  return moveIndex(list, from, from + delta);
}

export function moveBottomTo(stored: unknown, from: number, to: number): BottomEntry[] {
  return moveIndex(resolveBottomBar(stored), from, to);
}

export function setBottomShown(stored: unknown, id: BottomId, shown: boolean): BottomEntry[] {
  return resolveBottomBar(stored).map((entry) => (entry.id === id ? { ...entry, shown } : entry));
}

/** "Reset to default". */
export function resetTop(): TopEntry[] {
  return TOP_DEFAULT.map((entry) => ({ ...entry }));
}

export function resetBottom(): BottomEntry[] {
  return BOTTOM_DEFAULT.map((entry) => ({ ...entry }));
}

/** Entries set to Menu that can't be reached because the menu button is hidden. */
export function menuButtonHiddenWithEntries(stored: unknown): boolean {
  const list = resolveTopBar(stored);
  return (
    list.some((entry) => entry.id === 'menu' && entry.place === 'hidden') &&
    list.some((entry) => entry.place === 'menu')
  );
}
