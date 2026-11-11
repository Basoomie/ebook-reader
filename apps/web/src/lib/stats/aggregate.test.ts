/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  BEFORE_DEVICE_TRACKING,
  bookCharacterTotals,
  lastCompletion,
  readingSpeed,
  statEntriesFromRecords,
  totalsByDay,
  totalsOf
} from '$lib/stats/aggregate';

const BOOK = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
let n = 0;
const sid = (device: string) =>
  `${BOOK}:${device}:00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function record(
  kind: string,
  id: string,
  data: Record<string, unknown>,
  deleted = false
): LocalRecord {
  return {
    kind,
    id,
    bookId: BOOK,
    deviceId: A,
    updatedAt: 1,
    deletedAt: deleted ? 1 : null,
    rev: 1,
    data
  };
}

const session = (device: string, day: string, seconds: number, chars: number, extra = {}) =>
  record('stat-session', sid(device), {
    day,
    startedAt: 1,
    endedAt: 2,
    seconds,
    chars,
    lookups: 1,
    readThroughId: null,
    source: 'tracker',
    closed: true,
    ...extra
  });

const statDay = (day: string, seconds: number, chars: number) =>
  record('stat-day', `${BOOK}:${day}`, {
    dateKey: day,
    readingTime: seconds,
    charactersRead: chars,
    lastStatisticModified: 1
  });

const rt = (number: number, extra: Partial<ReadThrough> = {}): ReadThrough => ({
  id: `${BOOK}:${number}`,
  number,
  origin: 'start-over',
  startedOn: null,
  finished: false,
  finishedOn: null,
  manual: false,
  charCount: null,
  ...extra
});

describe('statEntriesFromRecords and totals', () => {
  it('sums sessions of every device and frozen days per day', () => {
    const entries = statEntriesFromRecords([
      session(A, '2026-11-12', 600, 6000),
      session(B, '2026-11-12', 300, 3000),
      session(A, '2026-11-13', 60, 500),
      statDay('2026-10-01', 120, 1000),
      record('position', `${BOOK}:${A}`, { charPos: 1 })
    ]);
    expect(entries).toHaveLength(4);
    expect(entries.find((e) => e.source === 'frozen')?.deviceId).toBe(BEFORE_DEVICE_TRACKING);
    const days = totalsByDay(entries);
    expect([...days.keys()].sort()).toEqual(['2026-10-01', '2026-11-12', '2026-11-13']);
    expect(days.get('2026-11-12')).toMatchObject({ seconds: 900, chars: 9000, lookups: 2 });
    expect(readingSpeed(days.get('2026-11-12')!)).toBe(36000);
    expect(totalsOf(entries, (e) => e.deviceId === B)).toMatchObject({ seconds: 300, chars: 3000 });
  });

  it('applies exclusions and corrections, and undoing them restores the session', () => {
    const s1 = session(A, '2026-11-12', 2400, 1000);
    const s2 = session(A, '2026-11-12', 600, 6000);
    const records = [
      s1,
      s2,
      record('stat-session-fix', s1.id, { seconds: 300 }),
      record('stat-session-fix', s2.id, { excluded: true })
    ];
    const entries = statEntriesFromRecords(records);
    expect(entries.find((e) => e.id === s1.id)).toMatchObject({
      seconds: 300,
      chars: 1000,
      recorded: { seconds: 2400, chars: 1000 }
    });
    expect(totalsOf(entries)).toMatchObject({ seconds: 300, chars: 1000, entries: 1 });
    // A deleted fix is an undo.
    const undone = statEntriesFromRecords([
      s1,
      s2,
      record('stat-session-fix', s1.id, {}, true),
      record('stat-session-fix', s2.id, {}, true)
    ]);
    expect(totalsOf(undone)).toMatchObject({ seconds: 3000, chars: 7000 });
  });

  it('counts completion characters but never time or speed', () => {
    const entries = statEntriesFromRecords([
      session(A, '2026-11-12', 3600, 30000),
      session(A, '2026-11-12', 99, 5000, { source: 'completion', lookups: 0 })
    ]);
    const t = totalsOf(entries);
    expect(t).toMatchObject({ seconds: 3600, chars: 35000 });
    expect(readingSpeed(t)).toBe(30000);
  });

  it('ignores damaged records', () => {
    expect(
      statEntriesFromRecords([
        record('stat-session', 'bad', { day: '2026-11-12' }),
        record('stat-session', sid(A), { day: 'x' }),
        record('stat-day', 'x', {}),
        session(A, '2026-11-12', -5, Number.NaN)
      ]).map((e) => [e.seconds, e.chars])
    ).toEqual([[0, 0]]);
  });
});

describe('bookCharacterTotals (WP8a rule on sessions)', () => {
  it('replaces the tracked characters of a manual completion with the book count', () => {
    const entries = statEntriesFromRecords([
      statDay('2026-10-01', 600, 4000),
      session(A, '2026-11-12', 600, 5000, { readThroughId: null }),
      session(A, '2026-11-14', 300, 2000, { readThroughId: `${BOOK}:2` })
    ]);
    const rts = [
      rt(1, { origin: 'completion', finished: true, finishedOn: '2026-11-13', manual: true }),
      rt(2, { startedOn: '2026-11-14' })
    ];
    expect(bookCharacterTotals(rts, entries, 90000)).toEqual({
      characters: 92000,
      trackedCharacters: 2000,
      readingTime: 1500,
      completed: 1,
      manualCompleted: 1
    });
    expect(bookCharacterTotals([], entries, 90000)).toMatchObject({ characters: 11000 });
  });

  it('gives the totals of the newest finished read-through', () => {
    const entries = statEntriesFromRecords([
      session(A, '2026-11-12', 600, 5000),
      session(B, '2026-11-13', 300, 2000),
      session(A, '2026-11-14', 300, 1000, { readThroughId: `${BOOK}:2` })
    ]);
    expect(lastCompletion([], entries)).toBeNull();
    const done = lastCompletion(
      [rt(1, { origin: 'completion', finished: true, finishedOn: '2026-11-13' }), rt(2)],
      entries
    );
    expect(done?.readThrough.number).toBe(1);
    expect(done?.totals).toMatchObject({ seconds: 900, chars: 7000 });
  });
});
