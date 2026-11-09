/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  BooksDbReadingGoal,
  BooksDbStatistic
} from '$lib/data/database/books-db/versions/books-db';
import { goalData } from '$lib/sync/record-goals';
import { STAT_DAY_KIND, statDayRow } from '$lib/sync/record-statistics';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * The apply side of WP5: pulled statistics and reading goals are written into
 * this device's local stores. Active only while the old sync is switched off,
 * so during the side-by-side week nothing from the new path can reach local
 * data (and from there the old sync's files).
 *
 * Positions are never applied silently; the "Continue from...?" prompt (WP9)
 * offers them. Deleted records never delete local data.
 */

export interface ApplyStatisticsDeps {
  /** Local titles per server book id (books this device knows). */
  titlesByBookId(): Promise<Map<string, Set<string>>>;
  statisticsForTitle(title: string): Promise<BooksDbStatistic[]>;
  /** Stores rows of one title without touching its other days. */
  putStatistics(title: string, rows: BooksDbStatistic[]): Promise<void>;
}

/**
 * Applies `stat-day` records: per day, the newer `lastStatisticModified` wins
 * (the old sync's NewOnly rule). Returns the number of rows written.
 */
export async function applyStatDays(
  records: LocalRecord[],
  deps: ApplyStatisticsDeps
): Promise<number> {
  const live = records.filter((r) => r.kind === STAT_DAY_KIND && r.deletedAt === null && r.bookId);
  if (!live.length) return 0;
  const titles = await deps.titlesByBookId();
  const byBook = new Map<string, LocalRecord[]>();
  for (const r of live) byBook.set(r.bookId!, [...(byBook.get(r.bookId!) ?? []), r]);

  let written = 0;
  for (const [bookId, bookRecords] of byBook) {
    for (const title of titles.get(bookId) ?? []) {
      const local = new Map((await deps.statisticsForTitle(title)).map((s) => [s.dateKey, s]));
      const rows: BooksDbStatistic[] = [];
      for (const r of bookRecords) {
        const row = statDayRow(title, r.data);
        const mine = local.get(row.dateKey);
        if (!mine || mine.lastStatisticModified < row.lastStatisticModified) rows.push(row);
      }
      if (rows.length) {
        await deps.putStatistics(title, rows);
        written += rows.length;
      }
    }
  }
  return written;
}

export interface ApplyGoalsDeps {
  localGoals(): Promise<BooksDbReadingGoal[]>;
  /** Replaces all local goals. */
  replaceGoals(goals: BooksDbReadingGoal[]): Promise<void>;
}

/**
 * Makes this device's goals equal the synced ones. Nothing happens when no
 * goal was ever synced (an empty set never wipes local goals).
 */
export async function applyReadingGoals(
  mirrored: BooksDbReadingGoal[],
  deps: ApplyGoalsDeps
): Promise<boolean> {
  if (!mirrored.length) return false;
  const key = (goals: BooksDbReadingGoal[]) =>
    JSON.stringify(
      [...goals]
        .sort((a, b) => (a.goalStartDate < b.goalStartDate ? -1 : 1))
        .map((g) => goalData(g))
    );
  if (key(await deps.localGoals()) === key(mirrored)) return false;
  await deps.replaceGoals(mirrored);
  return true;
}
