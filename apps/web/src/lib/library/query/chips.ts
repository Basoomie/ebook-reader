/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Library filter chips (WP7a): Reading, Unread, Completed, Dropped, Favorites, and On this
 * device (WP15e). A chip is not a separate filter; it edits the search text
 * (`status:reading,completed`, `favorite:yes`, `on:device`), so a chip and a typed filter can never disagree and a smart
 * collection (WP8b) is just the same text saved. Only the chip's own term is rewritten;
 * the rest of the query keeps the user's spelling.
 */

import { parseQuery, type QueryStatus, type QueryTerm } from './parse';

export type ChipId = QueryStatus | 'favorite' | 'device';

export const CHIPS: { id: ChipId; label: string }[] = [
  { id: 'reading', label: 'Reading' },
  { id: 'unread', label: 'Unread' },
  { id: 'completed', label: 'Completed' },
  { id: 'dropped', label: 'Dropped' },
  { id: 'favorite', label: 'Favorites' },
  { id: 'device', label: 'On this device' }
];

type StatusTerm = Extract<QueryTerm, { type: 'status' }>;
type FavoriteTerm = Extract<QueryTerm, { type: 'favorite' }>;
type DeviceTerm = Extract<QueryTerm, { type: 'device' }>;

/** Which chips the query turns on. Empty when the query doesn't parse. */
export function activeChips(text: string): Set<ChipId> {
  const parsed = parseQuery(text);
  const active = new Set<ChipId>();
  if (!parsed.ok) return active;
  for (const term of parsed.query.terms) {
    if (term.negated) continue;
    if (term.type === 'status') term.values.forEach((v) => active.add(v));
    if (term.type === 'favorite' && term.value) active.add('favorite');
    if (term.type === 'device') active.add('device');
  }
  return active;
}

/** Replaces text[start, end) and tidies the spaces around the cut. */
function splice(text: string, start: number, end: number, insert: string): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (insert !== '') return before + insert + after;
  return `${before.replace(/\s+$/, '')}${before.trim() && after.trim() ? ' ' : ''}${after.replace(/^\s+/, '')}`.trim();
}

function append(text: string, term: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed} ${term}` : term;
}

/**
 * The query with the chip switched on or off. Returns null when the query doesn't parse
 * (the chips are then disabled until the error is fixed).
 */
export function toggleChip(text: string, chip: ChipId): string | null {
  const parsed = parseQuery(text);
  if (!parsed.ok) return null;
  const terms = parsed.query.terms.filter((t) => !t.negated);

  if (chip === 'favorite') {
    const favorites = terms.filter((t): t is FavoriteTerm => t.type === 'favorite' && t.value);
    if (favorites.length === 0) return append(text, 'favorite:yes');
    let next = text;
    for (const term of [...favorites].reverse()) next = splice(next, term.start, term.end, '');
    return next;
  }

  if (chip === 'device') {
    const devices = terms.filter((t): t is DeviceTerm => t.type === 'device');
    if (devices.length === 0) return append(text, 'on:device');
    let next = text;
    for (const term of [...devices].reverse()) next = splice(next, term.start, term.end, '');
    return next;
  }

  const statuses = terms.filter((t): t is StatusTerm => t.type === 'status');
  if (statuses.length === 0) return append(text, `status:${chip}`);
  const on = statuses.some((t) => t.values.includes(chip));
  let next = text;
  // Right to left, so earlier spans stay valid.
  const ordered = [...statuses].sort((a, b) => b.start - a.start);
  for (const term of ordered) {
    let values = term.values;
    if (on) values = values.filter((v) => v !== chip);
    else if (term === statuses[0]) values = [...values, chip];
    if (values.length === term.values.length && values.every((v, i) => v === term.values[i])) {
      continue;
    }
    next = splice(next, term.start, term.end, values.length ? `status:${values.join(',')}` : '');
  }
  return next;
}
