/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md): what the user's 読書メーター lists
 * change in the reader. Pure: no DOM, no IndexedDB.
 *
 * Records (server: `apps/storage-server/src/sync/kinds.ts`):
 * - `bookmeter-entry`   id <account>:<listing>, written by the server: one entry of a list,
 *                       the reader books it matched (`books`) and the copy a status goes on
 *                       (`target`).
 * - `bookmeter-applied` id <bookId>, written by a device: the change it applied (or the user
 *                       skipped), so it happens once on any device.
 *
 * Rules (forward only; the user's own action always wins):
 * - 読んだ本 → Completed, finished on Bookmeter's date: not when the book is Completed already,
 *   nor when the user set its status by hand on or after that day (a Start over, Unread or
 *   Dropped of their own), nor without a date when the user set a status by hand at all.
 * - 読んでる本 → Reading: only an Unread book with no status of the user's own.
 * - 積読本 and 読みたい本 change nothing. Leaving a list changes nothing.
 * - A change already applied or skipped for the same entry and date is not planned again; a
 *   later read of the book (a new date) is.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import type { BookState } from '$lib/sync/book-state';

export const BOOKMETER_ENTRY_KIND = 'bookmeter-entry';
export const BOOKMETER_APPLIED_KIND = 'bookmeter-applied';

export type BookmeterList = 'read' | 'reading' | 'stacked' | 'wish';
const LISTS: BookmeterList[] = ['read', 'reading', 'stacked', 'wish'];

export interface BookmeterEntry {
  id: string;
  account: string;
  listing: string;
  list: BookmeterList;
  /** YYYY-MM-DD (read list only), or null. */
  date: string | null;
  title: string;
  authors: string[];
  cover: string | null;
  /** Higher = added later on Bookmeter. */
  rank: number;
  /** Every reader book the entry matched (copies). */
  books: string[];
  /** The copy a status goes on. */
  target: string | null;
  /** The account's switches. */
  statuses: boolean;
  wish: boolean;
}

export interface AppliedRecord {
  bookId: string;
  account: string;
  listing: string;
  list: 'read' | 'reading';
  date: string | null;
  /** held: left unticked in Review (still waiting, never applied without asking). */
  outcome: 'applied' | 'skipped' | 'held';
  at: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function entryFrom(r: LocalRecord): BookmeterEntry | null {
  if (r.kind !== BOOKMETER_ENTRY_KIND || r.deletedAt !== null) return null;
  const d = r.data ?? {};
  const list = LISTS.find((l) => l === d.list);
  const account = str(d.account);
  const listing = str(d.listing);
  if (!list || !account || !listing) return null;
  const date = str(d.date);
  return {
    id: r.id,
    account,
    listing,
    list,
    date: date && DATE_RE.test(date) ? date : null,
    title: str(d.title) ?? '',
    authors: Array.isArray(d.authors)
      ? d.authors.filter((a): a is string => typeof a === 'string')
      : [],
    cover: str(d.cover),
    rank: typeof d.rank === 'number' ? d.rank : 0,
    books: Array.isArray(d.books) ? d.books.filter((b): b is string => typeof b === 'string') : [],
    target: str(d.target),
    statuses: d.statuses !== false,
    wish: d.wish !== false
  };
}

export function appliedFrom(r: LocalRecord): AppliedRecord | null {
  if (r.kind !== BOOKMETER_APPLIED_KIND || r.deletedAt !== null) return null;
  const d = r.data ?? {};
  const list = d.list === 'read' || d.list === 'reading' ? d.list : null;
  const outcome =
    d.outcome === 'applied' || d.outcome === 'skipped' || d.outcome === 'held' ? d.outcome : null;
  const account = str(d.account);
  const listing = str(d.listing);
  if (!list || !outcome || !account || !listing) return null;
  const date = str(d.date);
  return {
    bookId: r.id,
    account,
    listing,
    list,
    date: date && DATE_RE.test(date) ? date : null,
    outcome,
    at: typeof d.at === 'number' ? d.at : 0
  };
}

/** The lists each reader book is on (every copy counts; bookmeter: searches). */
export function listsByBook(entries: readonly BookmeterEntry[]): Map<string, Set<BookmeterList>> {
  const out = new Map<string, Set<BookmeterList>>();
  for (const e of entries) {
    for (const b of e.books) {
      let s = out.get(b);
      if (!s) out.set(b, (s = new Set()));
      s.add(e.list);
    }
  }
  return out;
}

/** The best (newest) place of each reader book on a 読みたい本 list (every copy counts). */
export function wishRankByBook(entries: readonly BookmeterEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.list !== 'wish') continue;
    for (const b of e.books) if (e.rank > (out.get(b) ?? -Infinity)) out.set(b, e.rank);
  }
  return out;
}

/** The entries of one reader book (the book page). */
export function entriesOfBook(
  entries: readonly BookmeterEntry[],
  bookId: string
): BookmeterEntry[] {
  return entries.filter((e) => e.books.includes(bookId));
}

/** What a book's status record says about who set it and when (from its LocalRecord). */
export interface StatusInfo {
  /** The status record's last write (ms), or null when the book has none. */
  updatedAt: number | null;
  /** Set automatically (the reader's first page turn, or a Bookmeter Reading). */
  auto: boolean;
}

export type ChangeKind = 'complete' | 'reading';

export interface PlannedChange {
  bookId: string;
  kind: ChangeKind;
  /** The Bookmeter date (Completed's finish date), or null. */
  date: string | null;
  entry: BookmeterEntry;
  /** The reader's status before. */
  from: BookState['status'];
  /** Left unticked in Review once: shown again there, never applied without asking. */
  held: boolean;
}

export interface PlanInput {
  entries: readonly BookmeterEntry[];
  states: ReadonlyMap<string, BookState>;
  statusInfo: ReadonlyMap<string, StatusInfo>;
  applied: ReadonlyMap<string, AppliedRecord>;
  /** A date key (YYYY-MM-DD) of a time, on the tracker's day boundary. */
  dayOf(ms: number): string;
}

const LIST_ORDER: Record<BookmeterList, number> = { read: 0, reading: 1, stacked: 2, wish: 3 };

/** The changes to make, one per book, newest Bookmeter entries first. */
export function planChanges(input: PlanInput): PlannedChange[] {
  // One entry per target book: a read entry beats a reading one, then the latest date.
  const best = new Map<string, BookmeterEntry>();
  for (const e of input.entries) {
    if (!e.statuses || !e.target) continue;
    if (e.list !== 'read' && e.list !== 'reading') continue;
    const prev = best.get(e.target);
    if (
      !prev ||
      LIST_ORDER[e.list] < LIST_ORDER[prev.list] ||
      (e.list === prev.list && (e.date ?? '') > (prev.date ?? ''))
    )
      best.set(e.target, e);
  }
  const out: PlannedChange[] = [];
  for (const [bookId, e] of best) {
    const done = input.applied.get(bookId);
    const held =
      !!done && done.listing === e.listing && done.list === e.list && done.date === e.date;
    if (held && done.outcome !== 'held') continue;
    const state = input.states.get(bookId);
    const status = state?.status ?? 'unread';
    const info = input.statusInfo.get(bookId) ?? { updatedAt: null, auto: false };
    const own = info.updatedAt !== null && !info.auto;
    if (e.list === 'read') {
      if (status === 'completed') continue;
      if (own) {
        if (e.date === null) continue;
        if (input.dayOf(info.updatedAt as number) >= e.date) continue;
      }
      // The same finish already recorded (a read-through finished that day).
      if (state?.readThroughs.some((rt) => rt.finished && rt.finishedOn === e.date)) continue;
      out.push({ bookId, kind: 'complete', date: e.date, entry: e, from: status, held });
    } else {
      if (status !== 'unread' || own) continue;
      out.push({ bookId, kind: 'reading', date: null, entry: e, from: status, held });
    }
  }
  return out.sort(
    (a, b) =>
      (b.date ?? '').localeCompare(a.date ?? '') ||
      b.entry.rank - a.entry.rank ||
      a.bookId.localeCompare(b.bookId)
  );
}

/**
 * Whether these changes may be applied without asking: the account was reviewed once, there are
 * at most askAbove, and none was left unticked in Review (callers leave held ones out).
 */
export function mayApplyQuietly(
  changes: readonly PlannedChange[],
  reviewed: ReadonlySet<string>,
  askAbove: number
): boolean {
  if (changes.length === 0) return false;
  if (changes.some((c) => c.held)) return false;
  if (changes.length > askAbove) return false;
  return changes.every((c) => reviewed.has(c.entry.account));
}
