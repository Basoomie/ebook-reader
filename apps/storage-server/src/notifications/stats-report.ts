/**
 * Notifications N2: the daily, weekly and monthly stats messages (notifications-design.md
 * "Stats message" and "N2: decided before planning").
 *
 * - A period ends at the global day-start hour (`startDayHoursForTracker`) in the
 *   notifications' time zone; weeks start on `statsWeekStart`; months are calendar months.
 *   Both settings are the synced global ones (`setting` records `global:<key>`, written by
 *   the settings-source device); without one, the web app's defaults (0 h, Monday).
 * - The totals are the Stats page's: the web app's own code (vendor/stats.cjs) over every
 *   device's sessions, corrections, frozen days and read-throughs, no filter (all devices
 *   and libraries). Each session's day was set by the device that recorded it; the server
 *   only decides which period has ended. Reading synced after the message isn't in it.
 * - A finished period is compared whole with the whole previous one (as the Stats page does),
 *   when that message's "compare" setting is on (per message, on by default).
 * - Only the latest ended period of each kind is ever sent, once: a period missed while the
 *   server was off goes when it is back unless the next one has ended too (user, 2026-11-18).
 *
 * Everything here only reads ttsu.db.
 */
import type Database from 'better-sqlite3';
import { getUserByName, OWNER_NAME } from '../db/users';
import { globalSetting } from '../sync/global-setting';
import { ReportKind } from './stats-events';
import {
  ReadThrough,
  StatEntry,
  stats,
  StatsBookInfo,
  StatsPeriod,
  StatsRecord,
  StatsSummary,
} from './stats-bundle';
import type { NoReadingMode } from './settings';
import { linkText, TextFormat } from './messages';

export { REPORT_KINDS, STATS_EVENT } from './stats-events';
export type { ReportKind } from './stats-events';

export const STATS_KINDS = ['stat-session', 'stat-session-fix', 'stat-day', 'read-through'];

export interface StatsCalendar {
  /** The global day-start hour, 0-23. */
  dayStartHour: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number;
}

export const DEFAULT_CALENDAR: StatsCalendar = { dayStartHour: 0, weekStart: 1 };

/** The single user's id (the app is single-user: OWNER_NAME), or null. */
export function ownerId(db: Database.Database): string | null {
  return getUserByName(db, OWNER_NAME)?.id ?? null;
}

/** The day-start hour and week start the Stats page uses (read like the web app reads them). */
export function readCalendar(db: Database.Database, userId: string): StatsCalendar {
  const hourText = globalSetting(db, userId, 'startDayHoursForTracker');
  const hour = hourText === null ? NaN : Number(hourText);
  const weekText = globalSetting(db, userId, 'statsWeekStart');
  return {
    dayStartHour:
      Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_CALENDAR.dayStartHour,
    weekStart:
      weekText === null ? DEFAULT_CALENDAR.weekStart : stats.normalizeWeekStart(Number(weekText)),
  };
}

/**
 * Today's day key under the day boundary, from the wall clock in the notifications' zone:
 * before the day-start hour it is still the previous day (the web's getDateKey).
 */
export function statsToday(clock: { day: string; minutes: number }, dayStartHour: number): string {
  return clock.minutes < dayStartHour * 60 ? stats.addDays(clock.day, -1) : clock.day;
}

/** The most recent period of `kind` that has ended by `today`. */
export function lastEnded(kind: ReportKind, today: string, weekStart: number): StatsPeriod {
  return stats.stepPeriod(stats.periodContaining(kind, today, weekStart), -1, weekStart);
}

export interface StatsInput {
  entries: StatEntry[];
  readThroughs: Map<string, ReadThrough[]>;
  books: Map<string, StatsBookInfo>;
}

interface RecordRow {
  kind: string;
  id: string;
  book_id: string | null;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
  rev: number;
  data: string | null;
}

/** The user's live stats and read-through records, as a device mirror holds them. */
export function loadStatsRecords(db: Database.Database, userId: string): StatsRecord[] {
  const rows = db
    .prepare(
      `SELECT kind, id, book_id, device_id, updated_at, deleted_at, rev, data FROM sync_records
       WHERE user_id = ? AND kind IN (${STATS_KINDS.map(() => '?').join(', ')})
         AND deleted_at IS NULL`,
    )
    .all(userId, ...STATS_KINDS) as RecordRow[];
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    bookId: r.book_id,
    deviceId: r.device_id,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    rev: r.rev,
    data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null,
  }));
}

/**
 * The catalog's details of these books (the Stats page asks /books/lookup the same way:
 * enabled libraries, books gone from Calibre included). Only the character count matters
 * here: it is used for a manual completion without its own count.
 */
export function catalogBooks(db: Database.Database, ids: string[]): Map<string, StatsBookInfo> {
  const books = new Map<string, StatsBookInfo>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const found = db
      .prepare(
        `SELECT b.id, b.library_id, b.title, b.char_count, (s.missing_at IS NOT NULL) AS missing
         FROM books b
         JOIN book_sources s ON s.book_id = b.id AND s.kind IN ('calibre', 'upload')
         JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
         WHERE b.id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(...chunk) as {
      id: string;
      library_id: string;
      title: string;
      char_count: number | null;
      missing: number;
    }[];
    for (const b of found) {
      books.set(b.id, {
        title: b.title,
        libraryId: b.library_id,
        missing: b.missing === 1,
        charCount: b.char_count,
      });
    }
  }
  return books;
}

/**
 * Everything the Stats page reads from its mirror, from the server's records: the stats
 * entries, every book's read-throughs, and the catalog's details of books with
 * read-throughs.
 */
export function statsInputFrom(
  records: StatsRecord[],
  books: (ids: string[]) => Map<string, StatsBookInfo>,
): StatsInput {
  const entries = stats.statEntriesFromRecords(records.filter((r) => r.kind !== 'read-through'));
  const states = stats.bookStatesFrom(records.filter((r) => r.kind === 'read-through'));
  const readThroughs = new Map([...states].map(([id, s]) => [id, s.readThroughs]));
  return { entries, readThroughs, books: books([...readThroughs.keys()]) };
}

export function loadStatsInput(db: Database.Database, userId: string): StatsInput {
  return statsInputFrom(loadStatsRecords(db, userId), (ids) => catalogBooks(db, ids));
}

/** The Stats page's totals of a period, without filters. */
export function periodSummary(input: StatsInput, period: StatsPeriod): StatsSummary {
  return stats.buildStatsView({
    ...input,
    filter: { device: null, library: null, book: null },
    period,
  }).summary;
}

// ---- the message ----

const MINUS = '−';

export type LineKey = 'chars' | 'seconds' | 'speed' | 'lookups';
export const LINE_KEYS: LineKey[] = ['chars', 'seconds', 'speed', 'lookups'];
const LINE_LABEL: Record<LineKey, string> = {
  chars: 'Characters',
  seconds: 'Reading time',
  speed: 'Speed',
  lookups: 'Lookups',
};

/**
 * The change from the previous period, by the Stats page's own rules (`changeLine` in
 * period-compare.ts; a test checks both agree): the sign, the amount, and the percentage
 * ("<1" under 1 %), or why there is none.
 */
export type Change =
  /** Speed without tracked reading in this period: no change is shown. */
  | { kind: 'none' }
  /** Speed with tracked reading now but none in the previous period. */
  | { kind: 'speed-new' }
  | { kind: 'same' }
  /** The previous period had none of it. */
  | { kind: 'new'; sign: string; amount: string }
  | { kind: 'percent'; sign: string; amount: string; percent: string };

export function formatValue(key: LineKey, value: number): string {
  if (key === 'seconds') return stats.formatDuration(value);
  if (key === 'speed') return value ? `${stats.formatNumber(value)} / h` : '–';
  return stats.formatNumber(value);
}

export function changeOf(key: LineKey, cur: number, prev: number): Change {
  if (key === 'speed' && (!cur || !prev)) return !cur ? { kind: 'none' } : { kind: 'speed-new' };
  const diff = cur - prev;
  if (diff === 0) return { kind: 'same' };
  const sign = diff > 0 ? '+' : MINUS;
  const amount =
    key === 'seconds'
      ? stats.formatDuration(Math.abs(diff))
      : key === 'speed'
        ? `${stats.formatNumber(Math.abs(diff))} / h`
        : stats.formatNumber(Math.abs(diff));
  if (!prev) return { kind: 'new', sign, amount };
  const pct = (Math.abs(diff) / prev) * 100;
  return { kind: 'percent', sign, amount, percent: pct < 1 ? '<1' : String(Math.round(pct)) };
}

/** "+21,400, +13%", "no change", "none then" …, or null when no change is shown. */
export function changeText(key: LineKey, cur: number, prev: number): string | null {
  const c = changeOf(key, cur, prev);
  switch (c.kind) {
    case 'none':
      return null;
    case 'speed-new':
      return 'no tracked reading then';
    case 'same':
      return 'no change';
    case 'new':
      return `${c.sign}${c.amount}, none then`;
    case 'percent':
      return `${c.sign}${c.amount}, ${c.sign}${c.percent}%`;
  }
}

/**
 * One number of the message (user, 2026-11-21): "- **Characters:** 182,340 *(+21,400, +13%)*"
 * in Discord, "• Characters: 182,340 (+21,400, +13%)" in email; without the change when the
 * message doesn't compare (`prev` null).
 */
export function reportLine(
  key: LineKey,
  cur: StatsSummary,
  prev: StatsSummary | null,
  format: TextFormat,
): string {
  const label = LINE_LABEL[key];
  const value = formatValue(key, cur[key]);
  const change = prev ? changeText(key, cur[key], prev[key]) : null;
  if (format === 'markdown') {
    return `- **${label}:** ${value}${change ? ` *(${change})*` : ''}`;
  }
  return `• ${label}: ${value}${change ? ` (${change})` : ''}`;
}

const YEAR_END = / (\d{4})$/;

/** "week 9 – 15 Nov 2026", "Mon 16 Nov 2026", "November 2026". */
export function periodTitle(kind: ReportKind, period: StatsPeriod): string {
  const label = stats.periodLabel(period);
  return kind === 'week' ? `week ${label}` : label;
}

/** The previous period's label, without its year when it is the same as the period's. */
export function previousTitle(period: StatsPeriod, previous: StatsPeriod): string {
  const label = stats.periodLabel(previous);
  const year = YEAR_END.exec(label)?.[1];
  return year && year === period.to?.slice(0, 4) ? label.replace(YEAR_END, '') : label;
}

export function noReading(s: StatsSummary): boolean {
  return s.chars === 0 && s.seconds === 0 && s.lookups === 0;
}

export function statsLink(period: StatsPeriod): string {
  return `/statistics?period=${stats.periodToParam(period)}`;
}

export interface ReportOptions {
  linkBase: string;
  noReadingMode: NoReadingMode;
  /** Show each number's change from the previous period (the message's own setting). */
  compare: boolean;
}

/**
 * The message of one ended period in one channel's form, or null when it had no reading
 * and the setting skips such periods. The layout (user, 2026-11-21): the period as a
 * heading (the email subject), one line per number, then a small line with what it is
 * compared with and the link.
 *
 *   ### ッツ Reader · week 9 – 15 Nov 2026
 *   - **Characters:** 182,340 *(+21,400, +13%)*
 *   …
 *   -# vs 2 – 8 Nov · [View Stats](http://…/statistics?period=week:2026-11-09)
 */
export function reportText(
  o: {
    kind: ReportKind;
    period: StatsPeriod;
    previous: StatsPeriod;
    current: StatsSummary;
    /** The previous period's totals; null when the message doesn't compare. */
    before: StatsSummary | null;
  } & Omit<ReportOptions, 'compare'>,
  format: TextFormat,
): string | null {
  const url = `${o.linkBase}${statsLink(o.period)}`;
  const link = linkText('View Stats', url, format);
  const heading = `ッツ Reader · ${periodTitle(o.kind, o.period)}`;
  const md = format === 'markdown';
  const head = md ? `### ${heading}` : heading;
  if (noReading(o.current)) {
    if (o.noReadingMode === 'skip') return null;
    return [head, 'No reading.', md ? `-# ${link}` : link].join('\n');
  }
  const vs = o.before ? `vs ${previousTitle(o.period, o.previous)}` : null;
  const foot = md ? [`-# ${vs ? `${vs} · ` : ''}${link}`] : [...(vs ? [vs] : []), link];
  return [head, ...LINE_KEYS.map((k) => reportLine(k, o.current, o.before, format)), ...foot].join(
    '\n',
  );
}

/**
 * Everything about one ended period's message, for the service (and tests): its text in
 * each channel's form, or null when it isn't sent (no reading, skipped).
 */
export function buildReport(
  input: StatsInput,
  kind: ReportKind,
  period: StatsPeriod,
  weekStart: number,
  options: ReportOptions,
): Record<TextFormat, string> | null {
  const previous = stats.stepPeriod(period, -1, weekStart);
  const parts = {
    kind,
    period,
    previous,
    current: periodSummary(input, period),
    before: options.compare ? periodSummary(input, previous) : null,
    linkBase: options.linkBase,
    noReadingMode: options.noReadingMode,
  };
  const markdown = reportText(parts, 'markdown');
  const plain = reportText(parts, 'plain');
  return markdown === null || plain === null ? null : { markdown, plain };
}
