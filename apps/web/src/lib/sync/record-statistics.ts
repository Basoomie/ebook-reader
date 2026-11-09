/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Statistics over the record sync (WP5), side by side with the old file sync.
 *
 * One `stat-day` record per book and day holds exactly the old per-title daily
 * row (minus the title). After this device saves statistics, every day whose
 * row is newer than the record (by `lastStatisticModified`, the old sync's own
 * rule) is written. Rows the old sync brought from other devices are the same
 * data, so writing them again changes nothing that matters.
 *
 * Everything here is best effort and never throws into the tracker.
 */

export const STAT_DAY_KIND = 'stat-day';

const STAT_FIELDS = [
  'charactersRead',
  'readingTime',
  'minReadingSpeed',
  'altMinReadingSpeed',
  'lastReadingSpeed',
  'maxReadingSpeed',
  'lastStatisticModified'
] as const;

export function statDayId(bookId: string, dateKey: string): string {
  return `${bookId}:${dateKey}`;
}

/** The record payload of one local row (title dropped, unknown fields dropped). */
export function statDayData(row: BooksDbStatistic): Record<string, unknown> {
  const data: Record<string, unknown> = { dateKey: row.dateKey };
  for (const field of STAT_FIELDS) data[field] = Number(row[field]) || 0;
  if (row.completedBook !== undefined) data.completedBook = row.completedBook;
  if (row.completedData !== undefined) {
    const { title: _title, ...completed } = row.completedData as typeof row.completedData & {
      title?: string;
    };
    data.completedData = completed;
  }
  return data;
}

/** The local row of a record (for the apply side). */
export function statDayRow(title: string, data: Record<string, unknown>): BooksDbStatistic {
  const row: BooksDbStatistic = {
    title,
    dateKey: String(data.dateKey),
    charactersRead: Number(data.charactersRead) || 0,
    readingTime: Number(data.readingTime) || 0,
    minReadingSpeed: Number(data.minReadingSpeed) || 0,
    altMinReadingSpeed: Number(data.altMinReadingSpeed) || 0,
    lastReadingSpeed: Number(data.lastReadingSpeed) || 0,
    maxReadingSpeed: Number(data.maxReadingSpeed) || 0,
    lastStatisticModified: Number(data.lastStatisticModified) || 0
  };
  if (typeof data.completedBook === 'number') row.completedBook = data.completedBook;
  if (data.completedData && typeof data.completedData === 'object') {
    row.completedData = data.completedData as BooksDbStatistic['completedData'];
  }
  return row;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface RecordStatisticsDeps {
  getEngine(): Promise<SyncEngine>;
  bookIdForTitle(title: string): Promise<string | null>;
  statisticsForTitle(title: string): Promise<BooksDbStatistic[]>;
  warn(message: string): void;
}

/**
 * Writes this title's changed days. With `pruneMissing` (after the user
 * deleted statistics on this device), days that no longer exist locally are
 * deleted too. Returns how many records were queued; never throws.
 */
export async function recordStatistics(
  title: string,
  deps: RecordStatisticsDeps,
  options: { pruneMissing?: boolean } = {}
): Promise<number> {
  try {
    const bookId = await deps.bookIdForTitle(title);
    if (!bookId) return 0;
    const engine = await deps.getEngine();
    const rows = await deps.statisticsForTitle(title);
    let queued = 0;
    for (const row of rows) {
      if (!row?.dateKey) continue;
      const id = statDayId(bookId, row.dateKey);
      const data = statDayData(row);
      const existing = await engine.get(STAT_DAY_KIND, id);
      if (existing && existing.deletedAt === null) {
        const theirs = Number(existing.data.lastStatisticModified) || 0;
        if (theirs > row.lastStatisticModified) continue; // newer elsewhere
        if (theirs === row.lastStatisticModified && sameJson(existing.data, data)) continue;
      }
      if (await engine.put(STAT_DAY_KIND, id, data, { bookId })) queued += 1;
    }
    if (options.pruneMissing) {
      const days = new Set(rows.map((r) => r.dateKey));
      for (const r of await engine.getForBook(bookId)) {
        if (r.kind !== STAT_DAY_KIND || r.deletedAt !== null) continue;
        if (!days.has(String(r.data.dateKey)) && (await engine.remove(STAT_DAY_KIND, r.id))) {
          queued += 1;
        }
      }
    }
    return queued;
  } catch (error) {
    deps.warn(`Sync: could not record statistics: ${(error as Error)?.message ?? error}`);
    return 0;
  }
}
