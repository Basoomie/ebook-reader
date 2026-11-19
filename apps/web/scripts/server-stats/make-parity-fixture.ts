/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes apps/storage-server/tests/fixtures/stats-parity.json (notifications N2): records as
 * a device mirror holds them, the catalog's character counts, and the Stats page's
 * summaries per period, computed by this app's Stats code. The web test
 * (tests/stats/server-stats.test.ts) checks the summaries still are the source's; the
 * server's test checks it computes the same from its own database. Run after a deliberate
 * change to the Stats rules:
 *
 *   pnpm vite-node scripts/server-stats/make-parity-fixture.ts
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import { periodContaining, type StatsPeriod } from '$lib/stats/periods';
import { buildStatsView, type StatsBookInfo } from '$lib/stats/stats-view';
import { bookStatesFrom } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import { serverStatsOutput } from './build';

export const parityFixturePath = path.resolve(
  serverStatsOutput,
  '..',
  '..',
  'tests',
  'fixtures',
  'stats-parity.json'
);

const A = '0a1a0000-0000-4000-8000-00000000000a';
const B = '0b1b0000-0000-4000-8000-00000000000b';
const C = '0c1c0000-0000-4000-8000-00000000000c';
const D1 = 'd1000000-0000-4000-8000-0000000000d1';
const D2 = 'd2000000-0000-4000-8000-0000000000d2';
const T0 = Date.UTC(2026, 9, 1);

let n = 0;
const uuid = () => `5e550000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const records: LocalRecord[] = [];

function session(
  book: string,
  device: string,
  day: string,
  seconds: number,
  chars: number,
  lookups: number,
  extra: Record<string, unknown> = {}
): string {
  const id = `${book}:${device}:${uuid()}`;
  const startedAt = Date.parse(`${day}T10:00:00Z`) + n * 1000;
  records.push({
    kind: 'stat-session',
    id,
    bookId: book,
    deviceId: device,
    updatedAt: startedAt + seconds * 1000,
    deletedAt: null,
    rev: null,
    data: {
      day,
      startedAt,
      endedAt: startedAt + seconds * 1000,
      seconds,
      chars,
      lookups,
      readThroughId: null,
      source: 'tracker',
      closed: true,
      ...extra
    }
  });
  return id;
}

function frozen(book: string, day: string, readingTime: number, charactersRead: number) {
  records.push({
    kind: 'stat-day',
    id: `${book}:${day}`,
    bookId: book,
    deviceId: D1,
    updatedAt: T0,
    deletedAt: null,
    rev: null,
    data: {
      title: 'x',
      dateKey: day,
      charactersRead,
      readingTime,
      minReadingSpeed: 0,
      altMinReadingSpeed: 0,
      lastReadingSpeed: 0,
      maxReadingSpeed: 0,
      lastStatisticModified: T0
    }
  });
}

function readThrough(book: string, number: number, data: Record<string, unknown>) {
  records.push({
    kind: 'read-through',
    id: `${book}:${number}`,
    bookId: book,
    deviceId: D1,
    updatedAt: T0 + number,
    deletedAt: null,
    rev: null,
    data: {
      number,
      origin: 'start-over',
      startedOn: null,
      finished: false,
      finishedOn: null,
      manual: false,
      charCount: null,
      ...data
    }
  });
}

function fix(sessionId: string, data: Record<string, unknown>) {
  records.push({
    kind: 'stat-session-fix',
    id: sessionId,
    bookId: sessionId.split(':')[0],
    deviceId: D2,
    updatedAt: T0 + 99,
    deletedAt: null,
    rev: null,
    data
  });
}

// Before device tracking (frozen days), October.
frozen(A, '2026-10-05', 3600, 20000);
frozen(A, '2026-10-30', 1800, 9000);
// Book A: read on two devices across weeks and the month end; finished by the reader's
// Complete Book on 11-12 (read-through 1, not manual), then a second read-through.
session(A, D1, '2026-10-31', 1200, 7000, 4);
session(A, D2, '2026-11-01', 2400, 15000, 9);
session(A, D1, '2026-11-02', 900, 4000, 0);
fix(session(A, D2, '2026-11-03', 3000, 99999, 5), { excluded: true });
fix(session(A, D1, '2026-11-09', 1000, 5000, 2), { seconds: 1500, chars: 8000 });
session(A, D1, '2026-11-12', 600, 3000, 1);
session(A, D1, '2026-11-12', 0, 12000, 0, { source: 'completion' });
readThrough(A, 1, {
  origin: 'completion',
  finished: true,
  finishedOn: '2026-11-12',
  manual: false
});
readThrough(A, 2, { origin: 'start-over', startedOn: '2026-11-13' });
session(A, D2, '2026-11-15', 1800, 11000, 7, { readThroughId: `${A}:2` });
session(A, D2, '2026-11-16', 1800, 11000, 7, { readThroughId: `${A}:2` });
// Book B: tracked reading then marked completed by hand (its tracked characters are
// replaced by its own charCount on the finish day).
session(B, D2, '2026-11-08', 2000, 10000, 3);
session(B, D1, '2026-11-10', 1000, 6000, 1);
readThrough(B, 1, { finished: true, finishedOn: '2026-11-10', manual: true, charCount: 50000 });
// Book C: marked completed by hand without a count of its own: the catalog's count.
readThrough(C, 1, { finished: true, finishedOn: '2026-11-03', manual: true, charCount: null });
// 11-11: no reading at all.

const books = [
  { id: A, charCount: 100000 },
  { id: B, charCount: 60000 },
  { id: C, charCount: 70000 }
];

const periods: { weekStart: number; period: StatsPeriod }[] = [];
for (const day of [
  '2026-10-31',
  '2026-11-01',
  '2026-11-03',
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-16'
]) {
  periods.push({ weekStart: 1, period: periodContaining('day', day, 1) });
}
for (const weekStart of [1, 0]) {
  for (const day of ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']) {
    periods.push({ weekStart, period: periodContaining('week', day, weekStart) });
  }
}
for (const day of ['2026-10-01', '2026-11-01']) {
  periods.push({ weekStart: 1, period: periodContaining('month', day, 1) });
}

const entries = statEntriesFromRecords(records.filter((r) => r.kind !== 'read-through'));
const readThroughs = new Map(
  [...bookStatesFrom(records.filter((r) => r.kind === 'read-through'))].map(([id, s]) => [
    id,
    s.readThroughs
  ])
);
const bookMap = new Map<string, StatsBookInfo>(
  books.map((b) => [
    b.id,
    { title: 't', libraryId: 'lib1', missing: false, charCount: b.charCount }
  ])
);
const cases = periods.map(({ weekStart, period }) => ({
  weekStart,
  period,
  summary: buildStatsView({
    entries,
    readThroughs,
    books: bookMap,
    filter: { device: null, library: null, book: null },
    period
  }).summary
}));

const json = JSON.stringify({
  about:
    'Notifications N2 parity fixture, written by apps/web/scripts/server-stats/make-parity-fixture.ts: records (as a device mirror holds them), catalog character counts, and the Stats page summaries per period. apps/web/tests/stats/server-stats.test.ts checks the summaries are the web source results; apps/storage-server/tests/notifications-stats.test.ts checks the server gives the same from its own database.',
  devices: [D1, D2],
  books,
  records,
  cases
});
// Formatted as the commit hook would (the repository's Prettier settings).
const options = (await resolveConfig(parityFixturePath)) ?? {};
await writeFile(
  parityFixturePath,
  await format(json, { ...options, filepath: parityFixturePath }),
  'utf8'
);
console.log(`Wrote ${parityFixturePath} (${records.length} records, ${cases.length} periods)`);
