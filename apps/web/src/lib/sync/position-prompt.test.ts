/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  chapterLabelAt,
  findPromptCandidates,
  formatAge,
  formatPlace,
  formatWhen,
  mapPosition,
  updateHandled,
  type FindCandidatesInput
} from './position-prompt';
import type { LocalRecord } from './sync-db';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = '11111111-1111-4111-8111-111111111111';
const PHONE = '22222222-2222-4222-8222-222222222222';
const PC = '33333333-3333-4333-8333-333333333333';
const TABLET = '44444444-4444-4444-8444-444444444444';
const TOTAL = 100_000;

function pos(
  deviceId: string,
  charPos: number,
  updatedAt: number,
  extra: Partial<LocalRecord> & { progress?: number | null } = {}
): LocalRecord {
  const { progress, ...rest } = extra;
  return {
    kind: 'position',
    id: `${BOOK}:${deviceId}`,
    bookId: BOOK,
    deviceId,
    updatedAt,
    deletedAt: null,
    rev: 1,
    data: {
      charPos,
      progress: progress === undefined ? charPos / TOTAL : progress,
      readThroughId: null
    },
    ...rest
  };
}

function input(
  records: LocalRecord[],
  over: Partial<FindCandidatesInput> = {}
): FindCandidatesInput {
  return {
    records,
    ownDeviceId: ME,
    localPos: 10_000,
    localTotal: TOTAL,
    ownBaseline: null,
    minChars: 500,
    handled: {},
    deviceNames: { [PHONE]: 'Phone', [PC]: 'PC', [TABLET]: 'Tablet' },
    ...over
  };
}

describe('findPromptCandidates', () => {
  it('offers another device that is further along, with its name', () => {
    expect(findPromptCandidates(input([pos(PHONE, 40_000, 5)]))).toEqual([
      {
        recordId: `${BOOK}:${PHONE}`,
        updatedAt: 5,
        deviceId: PHONE,
        deviceName: 'Phone',
        isOwn: false,
        target: 40_000,
        approximate: false
      }
    ]);
  });

  it('ignores devices that are behind, level, or ahead by less than the threshold', () => {
    const records = [pos(PHONE, 9_000, 5), pos(PC, 10_000, 6), pos(TABLET, 10_499, 7)];
    expect(findPromptCandidates(input(records))).toEqual([]);
    expect(findPromptCandidates(input([pos(TABLET, 10_500, 7)]))).toHaveLength(1);
  });

  it('a threshold of 0 still needs the other device to be ahead', () => {
    expect(findPromptCandidates(input([pos(PHONE, 10_000, 5)], { minChars: 0 }))).toEqual([]);
    expect(findPromptCandidates(input([pos(PHONE, 10_001, 5)], { minChars: 0 }))).toHaveLength(1);
  });

  it('ignores deleted records, other kinds and malformed data', () => {
    const records: LocalRecord[] = [
      pos(PHONE, 40_000, 5, { deletedAt: 5, data: {} }),
      { ...pos(PC, 40_000, 5), kind: 'setting' },
      { ...pos(TABLET, 40_000, 5), data: { charPos: 'far' } },
      { ...pos(TABLET, 40_000, 5), id: 'not-a-position-id' }
    ];
    expect(findPromptCandidates(input(records))).toEqual([]);
  });

  it('skips a version already answered, but offers the next one', () => {
    const handled = { [`${BOOK}:${PHONE}`]: 5 };
    expect(findPromptCandidates(input([pos(PHONE, 40_000, 5)], { handled }))).toEqual([]);
    expect(findPromptCandidates(input([pos(PHONE, 41_000, 9)], { handled }))).toHaveLength(1);
  });

  it("offers this device's own record only on open, against the restored place", () => {
    const own = pos(ME, 30_000, 4);
    // Mid-session (no baseline): never.
    expect(findPromptCandidates(input([own], { localPos: 0 }))).toEqual([]);
    // On open: the legacy sync moved the bookmark back to 10,000.
    expect(findPromptCandidates(input([own], { ownBaseline: 10_000 }))).toEqual([
      expect.objectContaining({ deviceId: ME, isOwn: true, deviceName: null, target: 30_000 })
    ]);
    // Same place as restored: nothing to offer.
    expect(findPromptCandidates(input([own], { ownBaseline: 30_000, localPos: 0 }))).toEqual([]);
  });

  it('lists several devices newest first, at most three', () => {
    const records = [
      pos(PHONE, 40_000, 5),
      pos(PC, 50_000, 9),
      pos(TABLET, 20_000, 7),
      pos(ME, 60_000, 6)
    ];
    const result = findPromptCandidates(input(records, { ownBaseline: 10_000 }));
    expect(result.map((c) => c.deviceId)).toEqual([PC, TABLET, ME]);
  });

  it('maps a different copy of the book by percent and marks it approximate', () => {
    // The phone's copy has 50,000 characters; it is halfway.
    const record = pos(PHONE, 25_000, 5, { progress: 0.5 });
    expect(findPromptCandidates(input([record]))).toEqual([
      expect.objectContaining({ target: 50_000, approximate: true })
    ]);
  });

  it('uses the raw position when progress is missing', () => {
    const record = pos(PHONE, 25_000, 5, { progress: null });
    expect(findPromptCandidates(input([record]))).toEqual([
      expect.objectContaining({ target: 25_000, approximate: false })
    ]);
  });

  it('clamps a position past the end of this copy', () => {
    const record = pos(PHONE, 150_000, 5, { progress: null });
    expect(findPromptCandidates(input([record]))[0].target).toBe(TOTAL);
  });

  it('leaves the name empty when the device is unknown', () => {
    const result = findPromptCandidates(input([pos(PHONE, 40_000, 5)], { deviceNames: {} }));
    expect(result[0].deviceName).toBeNull();
  });
});

describe('mapPosition', () => {
  it('keeps the position for the same copy (rounding in progress included)', () => {
    expect(mapPosition(33_333, 33_333 / TOTAL, TOTAL)).toEqual({
      target: 33_333,
      approximate: false
    });
  });

  it('keeps the position when the local length is unknown', () => {
    expect(mapPosition(33_333, 0.5, 0)).toEqual({ target: 33_333, approximate: false });
  });
});

describe('updateHandled', () => {
  const phoneId = `${BOOK}:${PHONE}`;
  const pcId = `${BOOK}:${PC}`;
  const otherBookId = `${OTHER_BOOK}:${PHONE}`;

  it('adds answered versions and drops superseded or deleted ones of this book only', () => {
    const records = [pos(PHONE, 40_000, 9), pos(PC, 1, 3, { deletedAt: 3, data: {} })];
    const next = updateHandled({ [phoneId]: 5, [pcId]: 3, [otherBookId]: 2 }, BOOK, records, [
      { recordId: phoneId, updatedAt: 9 }
    ]);
    expect(next).toEqual({ [phoneId]: 9, [otherBookId]: 2 });
  });

  it('keeps entries that still match a live record', () => {
    const next = updateHandled({ [phoneId]: 5 }, BOOK, [pos(PHONE, 40_000, 5)], []);
    expect(next).toEqual({ [phoneId]: 5 });
  });
});

describe('chapterLabelAt', () => {
  const sections = [
    { label: '序章', startCharacter: 0 },
    { label: '第一章', startCharacter: 1000 },
    { label: '一', startCharacter: 1200, parentChapter: 'ch1' },
    { startCharacter: 3000 },
    { label: '第二章', startCharacter: 5000 }
  ];

  it('finds the top-level chapter containing the position', () => {
    expect(chapterLabelAt(sections, 0)).toBe('序章');
    expect(chapterLabelAt(sections, 1500)).toBe('第一章');
    // An unlabelled section keeps the previous label.
    expect(chapterLabelAt(sections, 4000)).toBe('第一章');
    expect(chapterLabelAt(sections, 9999)).toBe('第二章');
  });

  it('returns nothing without sections', () => {
    expect(chapterLabelAt([], 100)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats ages', () => {
    expect(formatAge(20_000)).toBe('just now');
    expect(formatAge(-5_000)).toBe('just now');
    expect(formatAge(12 * 60_000)).toBe('12 min ago');
    expect(formatAge(3 * 3_600_000 + 59 * 60_000)).toBe('3 h ago');
    expect(formatAge(26 * 3_600_000)).toBe('1 day ago');
    expect(formatAge(5 * 86_400_000)).toBe('5 days ago');
  });

  it('formats times as today, yesterday or a date (local time)', () => {
    const now = new Date(2026, 10, 9, 10, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 9, 8, 5).getTime(), now)).toBe('today 08:05');
    expect(formatWhen(new Date(2026, 10, 8, 21, 40).getTime(), now)).toBe('yesterday 21:40');
    expect(formatWhen(new Date(2026, 10, 3, 21, 40).getTime(), now)).toMatch(/3.*, 21:40$/);
  });

  it('formats a place', () => {
    expect(formatPlace(41_230, 107_900, '第四章')).toBe(
      `「第四章」 · 38.2% · ${(41_230).toLocaleString()} / ${(107_900).toLocaleString()}`
    );
    expect(formatPlace(500, 0, undefined)).toBe((500).toLocaleString());
  });
});
