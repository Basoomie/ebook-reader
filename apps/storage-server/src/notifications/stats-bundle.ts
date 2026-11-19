/**
 * The Stats page's pure code (notifications N2): vendor/stats.cjs, built by
 * `pnpm build:server-stats` in apps/web from apps/web/src/lib/stats/server-entry.ts, so the
 * stats messages show exactly the Stats page's totals. A web test fails when the committed
 * file is out of date. The types below mirror the web app's (aggregate.ts, periods.ts,
 * stats-view.ts, book-state.ts); the server tests run the real bundle.
 */
import path from 'path';

/** A synced record as the web app's mirror holds it (the server's SyncRecord fits). */
export interface StatsRecord {
  kind: string;
  id: string;
  bookId: string | null;
  deviceId: string;
  updatedAt: number;
  deletedAt: number | null;
  rev: number | null;
  data: Record<string, unknown> | null;
}

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

export interface StatsPeriod {
  kind: PeriodKind;
  from: string | null;
  to: string | null;
}

/** Opaque here: built by statEntriesFromRecords, read by buildStatsView. */
export type StatEntry = { readonly __entry: unique symbol };

export interface ReadThrough {
  id: string;
  number: number;
  finished: boolean;
  finishedOn: string | null;
  manual: boolean;
  charCount: number | null;
}

export interface StatsBookInfo {
  title: string;
  libraryId: string | null;
  missing: boolean;
  charCount: number | null;
}

export interface StatsSummary {
  seconds: number;
  chars: number;
  speed: number;
  lookups: number;
  booksCompleted: number;
  daysRead: number;
  manualChars: number;
}

export type SummaryKey = 'seconds' | 'chars' | 'speed' | 'booksCompleted' | 'lookups' | 'daysRead';

interface StatsBundle {
  statEntriesFromRecords(records: StatsRecord[]): StatEntry[];
  bookStatesFrom(records: StatsRecord[]): Map<string, { readThroughs: ReadThrough[] }>;
  buildStatsView(input: {
    entries: StatEntry[];
    readThroughs: Map<string, ReadThrough[]>;
    books: Map<string, StatsBookInfo>;
    filter: { device: string | null; library: string | null; book: string | null };
    period: StatsPeriod;
  }): { summary: StatsSummary };
  addDays(day: string, days: number): string;
  isDayKey(value: unknown): value is string;
  normalizeWeekStart(value: unknown): number;
  periodContaining(
    kind: Exclude<PeriodKind, 'custom'>,
    day: string,
    weekStart: number,
  ): StatsPeriod;
  periodLabel(period: StatsPeriod): string;
  periodToParam(period: StatsPeriod): string;
  stepPeriod(period: StatsPeriod, direction: -1 | 1, weekStart: number): StatsPeriod;
  changeLine(
    key: SummaryKey,
    current: StatsSummary,
    previous: StatsSummary,
    against: string,
  ): string | null;
  formatDuration(seconds: number): string;
  formatNumber(n: number): string;
}

/** From src/notifications (ts-node) and dist/notifications (Docker) alike: <package>/vendor. */
export const STATS_BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'stats.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const stats = require(STATS_BUNDLE) as StatsBundle;
