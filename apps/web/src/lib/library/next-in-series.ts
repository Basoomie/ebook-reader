/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookState, BookStatus } from '$lib/sync/book-state';
import { fnv1a64 } from '$lib/search-history/search-history';

/**
 * Next in your series (docs/design/next-in-series.md): for each series within one library,
 * the first volume after the furthest one you finished that you haven't started. Worked
 * out live, never stored. The server answers the same with SQL
 * (apps/storage-server/src/catalog/next-in-series.ts); both run the shared fixture
 * apps/storage-server/tests/fixtures/next-in-series.json.
 *
 * - Finished: status Completed or any finished read-through (a reread keeps it finished).
 * - Furthest finished: the highest series number among them (books without one don't count).
 * - Next: the lowest number above it among the books the library shows; omnibus volumes
 *   (N.9) never, bonus books (N.1) only with the setting. Two books on one number: the one
 *   added first. The series is left out when a book on that number was started (Reading or
 *   Dropped), when there is none, and when you hid the series.
 * - Order: the series whose volume you finished last first, by the read-throughs' finish day
 *   (then by book id, newest first: the server's order and the search sorted by Series last
 *   finished).
 */

export const SERIES_NEXT_HIDE_KIND = 'series-next-hide';

export type VolumeKind = 'main' | 'side' | 'bonus' | 'omnibus';

/** The cleanup's numbering: bonus N.1, side book N.5, omnibus N.9 (decisions.md, series order). */
export function volumeKind(index: number): VolumeKind {
  const frac = Math.round((index - Math.trunc(index)) * 1000) / 1000;
  if (frac === 0.9) return 'omnibus';
  if (frac === 0.1) return 'bonus';
  if (frac === 0) return 'main';
  return 'side';
}

/** Whether a volume of this number can be offered as the next one. */
export function offerable(index: number, bonus: boolean): boolean {
  const kind = volumeKind(index);
  return kind === 'omnibus' ? false : kind === 'bonus' ? bonus : true;
}

export interface NextBook {
  id: string;
  libraryId: string;
  series: { name: string; index: number | null } | null;
  addedAt: number;
  /** In an enabled library and not missing from Calibre: only these are offered. */
  visible: boolean;
}

export interface NextState {
  status: BookStatus;
  finished: boolean;
  /** When it was last finished (ms), for the order; 0 when unknown. */
  finishedAt: number;
}

export interface NextOptions {
  bonus: boolean;
  hidden(libraryId: string, seriesName: string): boolean;
}

export interface NextEntry {
  bookId: string;
  /** When the series' last finished volume was finished (ms; 0 unknown). */
  finishedAt: number;
}

/** Finished and when, from a book's synced state. */
export function finishedOf(
  state: BookState | undefined
): Pick<NextState, 'finished' | 'finishedAt'> {
  if (!state) return { finished: false, finishedAt: 0 };
  let finishedAt = 0;
  let finished = state.status === 'completed';
  for (const rt of state.readThroughs) {
    if (!rt.finished) continue;
    finished = true;
    const at = rt.finishedOn ? Date.parse(`${rt.finishedOn}T00:00:00Z`) : NaN;
    if (Number.isFinite(at) && at > finishedAt) finishedAt = at;
  }
  return { finished, finishedAt };
}

export function nextStateOf(state: BookState | undefined): NextState {
  return { status: state?.status ?? 'unread', ...finishedOf(state) };
}

function groupKey(libraryId: string, seriesName: string): string {
  return `${libraryId}\u0000${seriesName}`;
}

/** The hide record's id for a series in a library (the same on every device). */
export function hideRecordId(libraryId: string, seriesName: string): string {
  return fnv1a64(groupKey(libraryId, seriesName));
}

export function nextInSeries(
  books: readonly NextBook[],
  stateOf: (bookId: string) => NextState | undefined,
  opts: NextOptions
): NextEntry[] {
  const groups = new Map<string, { libraryId: string; name: string; books: NextBook[] }>();
  for (const book of books) {
    if (!book.series || book.series.index === null || !Number.isFinite(book.series.index)) {
      continue;
    }
    const key = groupKey(book.libraryId, book.series.name);
    let group = groups.get(key);
    if (!group) {
      group = { libraryId: book.libraryId, name: book.series.name, books: [] };
      groups.set(key, group);
    }
    group.books.push(book);
  }

  const out: NextEntry[] = [];
  for (const group of groups.values()) {
    let top = -Infinity;
    let finishedAt = 0;
    for (const book of group.books) {
      const state = stateOf(book.id);
      if (!state?.finished) continue;
      top = Math.max(top, book.series!.index!);
      finishedAt = Math.max(finishedAt, state.finishedAt);
    }
    if (top === -Infinity) continue;

    const candidates = group.books.filter(
      (b) => b.visible && b.series!.index! > top && offerable(b.series!.index!, opts.bonus)
    );
    if (candidates.length === 0) continue;
    const first = Math.min(...candidates.map((b) => b.series!.index!));
    const onFirst = candidates.filter((b) => b.series!.index === first);
    if (onFirst.some((b) => (stateOf(b.id)?.status ?? 'unread') !== 'unread')) continue;
    if (opts.hidden(group.libraryId, group.name)) continue;
    onFirst.sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push({ bookId: onFirst[0].id, finishedAt });
  }
  return out.sort(
    (a, b) =>
      b.finishedAt - a.finishedAt || (a.bookId < b.bookId ? 1 : a.bookId > b.bookId ? -1 : 0)
  );
}

/** A hide record's data. */
export interface HiddenSeries {
  id: string;
  libraryId: string;
  name: string;
  hiddenAt: number;
}

export function hiddenOf(record: {
  id: string;
  deletedAt: number | null;
  data: Record<string, unknown>;
}): HiddenSeries | null {
  if (record.deletedAt !== null) return null;
  const { library, name, hiddenAt } = record.data ?? {};
  if (typeof library !== 'string' || typeof name !== 'string') return null;
  return {
    id: record.id,
    libraryId: library,
    name,
    hiddenAt: typeof hiddenAt === 'number' ? hiddenAt : 0
  };
}
