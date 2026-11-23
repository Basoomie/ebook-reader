/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The per-device Links list (Settings > Library > Links), as the reader toolbars'
 * (reader-toolbar/toolbar-layout.ts): one entry per link in order, each Button, Menu or Hidden.
 * The stored list is kept exactly as stored (a copy from another device stores its exact
 * string); the book page and the settings screen always show `resolveLinks` of it. No stores
 * here, so it is tested on its own.
 */

import { BOOK_LINKS, LINK_IDS, type LinkId, type LinkPlace } from './links';

export interface LinkEntry {
  id: LinkId;
  place: LinkPlace;
}

/** The defaults, in the design's order (a new link goes at the end as hidden). */
export const LINKS_DEFAULT: readonly LinkEntry[] = Object.freeze(
  BOOK_LINKS.map((l) => Object.freeze({ id: l.id, place: l.defaultPlace }))
);

const ID_SET: ReadonlySet<string> = new Set(LINK_IDS);
const PLACES: ReadonlySet<string> = new Set(['button', 'menu', 'hidden']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The list as shown: known ids in stored order (the first of a repeated id), unknown ids and
 * invalid places ignored, every known id the list lacks added at the end as Hidden (a link
 * added in a later version). Anything but an array reads as the defaults.
 */
export function resolveLinks(stored: unknown): LinkEntry[] {
  if (!Array.isArray(stored)) return LINKS_DEFAULT.map((e) => ({ ...e }));
  const seen = new Set<LinkId>();
  const result: LinkEntry[] = [];
  for (const item of stored) {
    if (!isRecord(item)) continue;
    const { id, place } = item;
    if (typeof id !== 'string' || !ID_SET.has(id) || seen.has(id as LinkId)) continue;
    if (typeof place !== 'string' || !PLACES.has(place)) continue;
    seen.add(id as LinkId);
    result.push({ id: id as LinkId, place: place as LinkPlace });
  }
  for (const id of LINK_IDS) {
    if (!seen.has(id)) result.push({ id, place: 'hidden' });
  }
  return result;
}
