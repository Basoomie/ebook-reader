/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { readThroughOfDay, type CharacterTotals, type ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  parseStatSessionId,
  STAT_DAY_KIND,
  STAT_SESSION_FIX_KIND,
  STAT_SESSION_KIND
} from '$lib/stats/stat-records';

/**
 * Statistics from records (WP12). Pure: no Svelte, DOM or IndexedDB.
 *
 * Sessions are the only source of reading time and characters; day totals are
 * sums of sessions. Frozen `stat-day` rows (from before device tracking) are
 * included as one entry per book and day, under the pseudo-device
 * BEFORE_DEVICE_TRACKING. Rules:
 * - An excluded session counts nowhere; a corrected one counts its new numbers.
 * - Reading time: tracker sessions and frozen days.
 * - Speed: characters per hour of tracker sessions and frozen days only. A
 *   completion session ("Complete Book" adding the characters left) has
 *   characters but no time, so it never raises the speed.
 * - Per book, a manually completed read-through counts the book's character count
 *   instead of the tracked characters that belong to it (WP8a rule), and no time.
 */

export const BEFORE_DEVICE_TRACKING = 'before-device-tracking';

export type StatEntrySource = 'tracker' | 'completion' | 'frozen';

export interface StatEntry {
  /** The session id, or the stat-day id (<bookId>:<day>) for a frozen day. */
  id: string;
  bookId: string;
  /** The device that recorded it, or BEFORE_DEVICE_TRACKING. */
  deviceId: string;
  day: string;
  seconds: number;
  chars: number;
  lookups: number;
  /**
   * Sessions: their read-through (null = the first). Frozen days: undefined, they
   * belong to a read-through by date.
   */
  readThroughId: string | null | undefined;
  source: StatEntrySource;
  startedAt: number | null;
  endedAt: number | null;
  closed: boolean;
  excluded: boolean;
  /** The numbers as recorded, when a correction replaced them. */
  recorded: { seconds: number; chars: number } | null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every statistics entry in a set of mirrored records (other kinds are ignored). */
export function statEntriesFromRecords(records: LocalRecord[]): StatEntry[] {
  const fixes = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    if (r.kind === STAT_SESSION_FIX_KIND && r.deletedAt === null) fixes.set(r.id, r.data ?? {});
  }
  const out: StatEntry[] = [];
  for (const r of records) {
    if (r.deletedAt !== null) continue;
    if (r.kind === STAT_SESSION_KIND) {
      const parsed = parseStatSessionId(r.id);
      const d = r.data ?? {};
      if (!parsed || typeof d.day !== 'string' || !DAY_RE.test(d.day)) continue;
      const source = d.source === 'completion' ? 'completion' : 'tracker';
      const seconds = source === 'completion' ? 0 : count(d.seconds);
      const chars = count(d.chars);
      const fix = fixes.get(r.id);
      const corrected = !!fix && (typeof fix.seconds === 'number' || typeof fix.chars === 'number');
      out.push({
        id: r.id,
        bookId: parsed.bookId,
        deviceId: parsed.deviceId,
        day: d.day,
        seconds: fix && typeof fix.seconds === 'number' ? count(fix.seconds) : seconds,
        chars: fix && typeof fix.chars === 'number' ? count(fix.chars) : chars,
        lookups: count(d.lookups),
        readThroughId: typeof d.readThroughId === 'string' ? d.readThroughId : null,
        source,
        startedAt: typeof d.startedAt === 'number' ? d.startedAt : null,
        endedAt: typeof d.endedAt === 'number' ? d.endedAt : null,
        closed: d.closed === true,
        excluded: fix?.excluded === true,
        recorded: corrected ? { seconds, chars } : null
      });
    } else if (r.kind === STAT_DAY_KIND) {
      const [bookPart, day] = r.id.split(':');
      const bookId = r.bookId ?? bookPart;
      if (!bookId || !day || !DAY_RE.test(day)) continue;
      out.push({
        id: r.id,
        bookId,
        deviceId: BEFORE_DEVICE_TRACKING,
        day,
        seconds: count(r.data?.readingTime),
        chars: count(r.data?.charactersRead),
        lookups: 0,
        readThroughId: undefined,
        source: 'frozen',
        startedAt: null,
        endedAt: null,
        closed: true,
        excluded: false,
        recorded: null
      });
    }
  }
  return out;
}

export interface StatTotals {
  /** Reading time (seconds). */
  seconds: number;
  /** Characters (tracker, completion and frozen). */
  chars: number;
  lookups: number;
  /** Time and characters that speed is computed from (no completion characters). */
  speedSeconds: number;
  speedChars: number;
  /** Entries counted. */
  entries: number;
}

export function emptyTotals(): StatTotals {
  return { seconds: 0, chars: 0, lookups: 0, speedSeconds: 0, speedChars: 0, entries: 0 };
}

export function addToTotals(totals: StatTotals, entry: StatEntry): StatTotals {
  if (entry.excluded) return totals;
  totals.entries += 1;
  totals.chars += entry.chars;
  totals.lookups += entry.lookups;
  if (entry.source !== 'completion') {
    totals.seconds += entry.seconds;
    totals.speedSeconds += entry.seconds;
    totals.speedChars += entry.chars;
  }
  return totals;
}

/** Characters per hour (rounded up, as the tracker does); 0 without time. */
export function readingSpeed(totals: Pick<StatTotals, 'speedSeconds' | 'speedChars'>): number {
  return totals.speedSeconds > 0 ? Math.ceil((3600 * totals.speedChars) / totals.speedSeconds) : 0;
}

export function totalsOf(
  entries: Iterable<StatEntry>,
  filter: (entry: StatEntry) => boolean = () => true
): StatTotals {
  const totals = emptyTotals();
  for (const e of entries) if (filter(e)) addToTotals(totals, e);
  return totals;
}

/** Totals per day key (only days with at least one counted entry). */
export function totalsByDay(
  entries: Iterable<StatEntry>,
  filter: (entry: StatEntry) => boolean = () => true
): Map<string, StatTotals> {
  const out = new Map<string, StatTotals>();
  for (const e of entries) {
    if (e.excluded || !filter(e)) continue;
    let t = out.get(e.day);
    if (!t) {
      t = emptyTotals();
      out.set(e.day, t);
    }
    addToTotals(t, e);
  }
  return out;
}

/** The read-through an entry belongs to (null = the implicit first, without a record). */
export function readThroughOfEntry(
  readThroughs: ReadThrough[],
  entry: StatEntry
): ReadThrough | null {
  if (entry.readThroughId === undefined) return readThroughOfDay(readThroughs, entry.day);
  const number = entry.readThroughId === null ? 1 : Number(entry.readThroughId.split(':')[1]);
  return readThroughs.find((rt) => rt.number === number) ?? null;
}

/**
 * One book's totals (WP8a rule on sessions): a manually completed read-through
 * counts the book's character count instead of the tracked characters that belong
 * to it; time is only ever tracked time.
 */
export function bookCharacterTotals(
  readThroughs: ReadThrough[],
  entries: StatEntry[],
  catalogCount: number | null
): CharacterTotals {
  let trackedCharacters = 0;
  let readingTime = 0;
  for (const e of entries) {
    if (e.excluded) continue;
    if (e.source !== 'completion') readingTime += e.seconds;
    if (!readThroughOfEntry(readThroughs, e)?.manual) trackedCharacters += e.chars;
  }
  let manualCharacters = 0;
  let manualCompleted = 0;
  for (const rt of readThroughs) {
    if (!rt.finished || !rt.manual) continue;
    manualCompleted += 1;
    manualCharacters += rt.charCount ?? catalogCount ?? 0;
  }
  return {
    characters: trackedCharacters + manualCharacters,
    trackedCharacters,
    readingTime,
    completed: readThroughs.filter((r) => r.finished).length,
    manualCompleted
  };
}

/** The newest finished read-through and the totals of what belongs to it, for the tracker. */
export function lastCompletion(
  readThroughs: ReadThrough[],
  entries: StatEntry[]
): { readThrough: ReadThrough; totals: StatTotals } | null {
  const finished = readThroughs.filter((rt) => rt.finished);
  const last = finished[finished.length - 1];
  if (!last) return null;
  const totals = totalsOf(
    entries,
    (e) =>
      readThroughOfEntry(readThroughs, e)?.number === last.number ||
      (last.number === 1 && !readThroughOfEntry(readThroughs, e))
  );
  return { readThrough: last, totals };
}
