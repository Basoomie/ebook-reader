/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Recently viewed (2026-11-24, docs/design/recently-viewed.md): pure rules, no storage.
 *
 * One synced record per book whose details page you looked at (kind "recently-viewed",
 * id = the book id, data { viewedAt }). Viewing it again moves it to the front. The cards
 * come from the catalog, so no title is kept; a removed book is a deletion marker.
 */

export const RECENTLY_VIEWED_KIND = 'recently-viewed';

export interface ViewedEntry {
  bookId: string;
  viewedAt: number;
}

/** What is kept: the last N books, the last N days, or everything. */
export type KeepMode = 'books' | 'days' | 'all';

export interface Keep {
  mode: KeepMode;
  books: number;
  days: number;
}

export const KEEP_BOOKS_DEFAULT = 100;
export const KEEP_BOOKS_MIN = 1;
export const KEEP_BOOKS_MAX = 1000;
export const KEEP_DAYS_DEFAULT = 30;
export const KEEP_DAYS_MIN = 1;
export const KEEP_DAYS_MAX = 3650;
export const DWELL_DEFAULT = 3;
export const DWELL_MAX = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored number as a whole number within its bounds (a bad value reads as the default). */
export function clampSetting(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function keepMode(value: unknown): KeepMode {
  return value === 'days' || value === 'all' ? value : 'books';
}

/** A stored record as an entry, or null when it is deleted or not usable. */
export function entryOf(record: {
  id: string;
  deletedAt: number | null;
  data: Record<string, unknown>;
}): ViewedEntry | null {
  if (record.deletedAt !== null) return null;
  const viewedAt = record.data?.viewedAt;
  if (!record.id || typeof viewedAt !== 'number' || !Number.isFinite(viewedAt)) return null;
  return { bookId: record.id, viewedAt };
}

export function newestFirst(a: ViewedEntry, b: ViewedEntry): number {
  return b.viewedAt - a.viewedAt || (a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0);
}

/** The entries the limit keeps, newest first. */
export function kept(entries: readonly ViewedEntry[], keep: Keep, now: number): ViewedEntry[] {
  const sorted = [...entries].sort(newestFirst);
  if (keep.mode === 'all') return sorted;
  if (keep.mode === 'books') return sorted.slice(0, keep.books);
  const since = now - keep.days * DAY_MS;
  return sorted.filter((e) => e.viewedAt >= since);
}

/** The books to remove: those the limit no longer keeps. */
export function trimIds(entries: readonly ViewedEntry[], keep: Keep, now: number): string[] {
  const stay = new Set(kept(entries, keep, now).map((e) => e.bookId));
  return entries.filter((e) => !stay.has(e.bookId)).map((e) => e.bookId);
}

/** The local calendar day of a time, as a sortable key (yyyy-mm-dd). */
function dayKey(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(time: number, now: number): string {
  const key = dayKey(time);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  const d = new Date(time);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  });
}

export interface ViewedDay<T> {
  key: string;
  label: string;
  items: T[];
}

/** Items (newest first) under day headings: Today, Yesterday, then dates. */
export function groupByDay<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  now: number
): ViewedDay<T>[] {
  const out: ViewedDay<T>[] = [];
  for (const item of items) {
    const time = timeOf(item);
    const key = dayKey(time);
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(time, now), items: [item] });
  }
  return out;
}
