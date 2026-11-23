/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The edits of Settings > Library > Links (as reader-toolbar/toolbar-edit.ts). Each takes the
 * stored value (anything: a copy from another device, an old list, nothing), works on what is
 * shown of it (`resolveLinks`) and returns the new full list to store.
 */

import { LINKS_DEFAULT, resolveLinks, type LinkEntry } from './link-layout';
import type { LinkId, LinkPlace } from './links';

function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return list;
  }
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** One step up (-1) or down (+1); nothing happens at the ends. */
export function moveLink(stored: unknown, id: LinkId, delta: -1 | 1): LinkEntry[] {
  const list = resolveLinks(stored);
  const from = list.findIndex((e) => e.id === id);
  return moveIndex(list, from, from + delta);
}

/** A drop: the entry at `from` goes to `to` (indexes in the shown list). */
export function moveLinkTo(stored: unknown, from: number, to: number): LinkEntry[] {
  return moveIndex(resolveLinks(stored), from, to);
}

export function setLinkPlace(stored: unknown, id: LinkId, place: LinkPlace): LinkEntry[] {
  return resolveLinks(stored).map((e) => (e.id === id ? { ...e, place } : e));
}

/** "Reset to default". */
export function resetLinks(): LinkEntry[] {
  return LINKS_DEFAULT.map((e) => ({ ...e }));
}
