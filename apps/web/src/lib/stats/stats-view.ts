/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  addToTotals,
  BEFORE_DEVICE_TRACKING,
  emptyTotals,
  readingSpeed,
  readThroughOfEntry,
  type StatEntry,
  type StatTotals
} from '$lib/stats/aggregate';
import { inPeriod, type StatsPeriod } from '$lib/stats/periods';
import type { ReadThrough } from '$lib/sync/book-state';

/**
 * What the Stats page shows (WP12b), from statistics entries, read-throughs and
 * what is known about each book. Pure.
 *
 * Rules (decisions.md, WP12):
 * - Filters: device (a device id or BEFORE_DEVICE_TRACKING), library, book.
 * - Reading time and speed: tracked reading only (sessions and frozen days).
 * - Characters: tracked characters, except those that belong to a manually completed
 *   read-through, which counts the book's character count instead, on its finish day
 *   (WP8a rule). Manual completions have no device, so they count only without a
 *   device filter. A completion without a finish date counts only under "All".
 * - Books completed: read-throughs finished in the period (manual ones included); they
 *   have no device, so a device filter doesn't narrow them.
 */

export interface StatsBookInfo {
  title: string;
  libraryId: string | null;
  /** Removed from Calibre (or its upload source gone): reading stays. */
  missing: boolean;
  /** The catalog's character count (for manual completions). */
  charCount: number | null;
  /** WP12d: absolute cover thumbnail URL from the catalog (for the Stats image). */
  thumbnail?: string | null;
}

export interface StatsFilter {
  device: string | null;
  library: string | null;
  book: string | null;
}

export interface StatsViewInput {
  entries: StatEntry[];
  readThroughs: Map<string, ReadThrough[]>;
  books: Map<string, StatsBookInfo>;
  filter: StatsFilter;
  period: StatsPeriod;
}

export interface StatsSummary {
  seconds: number;
  chars: number;
  speed: number;
  lookups: number;
  booksCompleted: number;
  daysRead: number;
  /** Characters from manual completions included in `chars`. */
  manualChars: number;
}

export interface StatsBookRow {
  bookId: string;
  title: string;
  missing: boolean;
  seconds: number;
  chars: number;
  speed: number;
  lookups: number;
  /** Finished in the period (any kind of completion). */
  completed: boolean;
  /** Of which marked completed by hand (characters only). */
  manual: boolean;
}

export interface StatsDayRow {
  day: string;
  totals: StatTotals;
  /** Every entry of the day (excluded sessions too, so they can be restored), in time order. */
  entries: StatEntry[];
}

export interface HeatmapRow {
  title: string;
  dateKey: string;
  readingTime: number;
  charactersRead: number;
}

export interface StatsView {
  summary: StatsSummary;
  books: StatsBookRow[];
  days: StatsDayRow[];
  /** Per-day totals over all time for the heatmap (filters applied, period not). */
  heatmapDays: Map<string, StatTotals>;
  /** The heatmap's input: one row per book and day (filters applied, all time), by date. */
  heatmapRows: HeatmapRow[];
}

export function unknownBookTitle(bookId: string): string {
  return `Unknown book (${bookId.slice(0, 8)})`;
}

function bookInfo(books: Map<string, StatsBookInfo>, bookId: string): StatsBookInfo {
  return (
    books.get(bookId) ?? {
      title: unknownBookTitle(bookId),
      libraryId: null,
      missing: false,
      charCount: null
    }
  );
}

function passesBookFilters(bookId: string, input: StatsViewInput): boolean {
  const { filter, books } = input;
  if (filter.book && bookId !== filter.book) return false;
  if (filter.library && books.get(bookId)?.libraryId !== filter.library) return false;
  return true;
}

export function passesFilter(entry: StatEntry, input: StatsViewInput): boolean {
  if (input.filter.device && entry.deviceId !== input.filter.device) return false;
  return passesBookFilters(entry.bookId, input);
}

/** Whether the entry's characters are replaced by a manual completion of its read-through. */
function inManualCompletion(entry: StatEntry, readThroughs: Map<string, ReadThrough[]>): boolean {
  const rts = readThroughs.get(entry.bookId);
  if (!rts?.length) return false;
  const rt = readThroughOfEntry(rts, entry);
  return !!rt?.finished && rt.manual;
}

/** Totals of entries, with the manual-completion rule on characters. */
function addCounted(
  totals: StatTotals,
  entry: StatEntry,
  readThroughs: Map<string, ReadThrough[]>
): void {
  if (entry.excluded) return;
  addToTotals(totals, inManualCompletion(entry, readThroughs) ? { ...entry, chars: 0 } : entry);
}

const byTime = (a: StatEntry, b: StatEntry) =>
  (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id);

export function buildStatsView(input: StatsViewInput): StatsView {
  const { entries, readThroughs, books, filter, period } = input;
  const filtered = entries.filter((e) => passesFilter(e, input));
  const heatmapDays = new Map<string, StatTotals>();
  const heatmapRowMap = new Map<string, HeatmapRow>();
  const dayMap = new Map<string, StatsDayRow>();
  const bookMap = new Map<string, StatsBookRow & { totals: StatTotals }>();
  const summary = emptyTotals();

  const bookRow = (bookId: string) => {
    let row = bookMap.get(bookId);
    if (!row) {
      const info = bookInfo(books, bookId);
      row = {
        bookId,
        title: info.title,
        missing: info.missing,
        seconds: 0,
        chars: 0,
        speed: 0,
        lookups: 0,
        completed: false,
        manual: false,
        totals: emptyTotals()
      };
      bookMap.set(bookId, row);
    }
    return row;
  };

  for (const entry of filtered) {
    let heat = heatmapDays.get(entry.day);
    if (!heat) heatmapDays.set(entry.day, (heat = emptyTotals()));
    addCounted(heat, entry, readThroughs);
    if (!entry.excluded) {
      const key = `${entry.bookId}|${entry.day}`;
      let row = heatmapRowMap.get(key);
      if (!row) {
        row = {
          title: bookInfo(books, entry.bookId).title,
          dateKey: entry.day,
          readingTime: 0,
          charactersRead: 0
        };
        heatmapRowMap.set(key, row);
      }
      if (entry.source !== 'completion') row.readingTime += entry.seconds;
      if (!inManualCompletion(entry, readThroughs)) row.charactersRead += entry.chars;
    }

    if (!inPeriod(entry.day, period)) continue;
    let day = dayMap.get(entry.day);
    if (!day) dayMap.set(entry.day, (day = { day: entry.day, totals: emptyTotals(), entries: [] }));
    day.entries.push(entry);
    addCounted(day.totals, entry, readThroughs);
    addCounted(summary, entry, readThroughs);
    if (!entry.excluded) addCounted(bookRow(entry.bookId).totals, entry, readThroughs);
  }

  // Completions (read-throughs have no device).
  let booksCompleted = 0;
  let manualChars = 0;
  for (const [bookId, rts] of readThroughs) {
    if (!passesBookFilters(bookId, input)) continue;
    for (const rt of rts) {
      if (!rt.finished) continue;
      const counts = rt.finishedOn ? inPeriod(rt.finishedOn, period) : period.kind === 'all';
      if (!counts) continue;
      booksCompleted += 1;
      const row = bookRow(bookId);
      row.completed = true;
      if (rt.manual) {
        row.manual = true;
        if (!filter.device) {
          const chars = rt.charCount ?? bookInfo(books, bookId).charCount ?? 0;
          manualChars += chars;
          row.totals.chars += chars;
          if (rt.finishedOn) {
            let heat = heatmapDays.get(rt.finishedOn);
            if (!heat) heatmapDays.set(rt.finishedOn, (heat = emptyTotals()));
            heat.chars += chars;
            let day = dayMap.get(rt.finishedOn);
            if (!day) {
              day = { day: rt.finishedOn, totals: emptyTotals(), entries: [] };
              dayMap.set(rt.finishedOn, day);
            }
            day.totals.chars += chars;
          }
        }
      }
    }
  }
  // Manual completions in earlier periods still add their characters to the heatmap.
  if (!filter.device) {
    for (const [bookId, rts] of readThroughs) {
      if (!passesBookFilters(bookId, input)) continue;
      for (const rt of rts) {
        if (!rt.finished || !rt.manual || !rt.finishedOn || inPeriod(rt.finishedOn, period)) {
          continue;
        }
        let heat = heatmapDays.get(rt.finishedOn);
        if (!heat) heatmapDays.set(rt.finishedOn, (heat = emptyTotals()));
        heat.chars += rt.charCount ?? bookInfo(books, bookId).charCount ?? 0;
      }
    }
  }

  const days = [...dayMap.values()]
    .map((d) => ({ ...d, entries: d.entries.sort(byTime) }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  // A day counts as read when something was tracked (a manual completion alone isn't reading).
  const daysRead = days.filter((d) =>
    d.entries.some((e) => !e.excluded && (e.seconds > 0 || e.chars > 0))
  ).length;

  const bookRows = [...bookMap.values()]
    .map(({ totals, ...row }) => ({
      ...row,
      seconds: totals.seconds,
      chars: totals.chars,
      speed: readingSpeed(totals),
      lookups: totals.lookups
    }))
    .filter((row) => row.seconds > 0 || row.chars > 0 || row.completed || row.lookups > 0)
    .sort((a, b) => b.seconds - a.seconds || b.chars - a.chars || a.title.localeCompare(b.title));

  return {
    summary: {
      seconds: summary.seconds,
      chars: summary.chars + manualChars,
      speed: readingSpeed(summary),
      lookups: summary.lookups,
      booksCompleted,
      daysRead,
      manualChars
    },
    books: bookRows,
    days,
    heatmapDays,
    heatmapRows: [...heatmapRowMap.values()].sort((a, b) =>
      a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0
    )
  };
}

/** Devices that recorded something, newest-named first; "before device tracking" last. */
export function devicesIn(
  entries: StatEntry[],
  names: Map<string, string>
): { id: string; name: string }[] {
  const ids = new Set(entries.map((e) => e.deviceId));
  const out = [...ids]
    .filter((id) => id !== BEFORE_DEVICE_TRACKING)
    .map((id) => ({ id, name: names.get(id) ?? `Device ${id.slice(0, 4)}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (ids.has(BEFORE_DEVICE_TRACKING)) {
    out.push({ id: BEFORE_DEVICE_TRACKING, name: 'Before device tracking' });
  }
  return out;
}

/**
 * Lines in the TMW log format, one per book, for the period's characters or minutes:
 * `.log reading 12345 <title>` / `.log readtime 42 <title>`.
 */
export function tmwLog(
  view: StatsView,
  periodText: string,
  what: 'chars' | 'minutes'
): string | null {
  const lines = [`Reading Data for ${periodText}`, ''];
  for (const row of view.books) {
    const value = what === 'chars' ? row.chars : Math.floor(row.seconds / 60);
    if (value)
      lines.push(`.log ${what === 'chars' ? 'reading' : 'readtime'} ${value} ${row.title}`);
  }
  return lines.length > 2 ? lines.join('\n') : null;
}
