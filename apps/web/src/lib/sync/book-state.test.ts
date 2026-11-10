/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  bookStateFrom,
  bookStatesFrom,
  characterTotals,
  currentReadThrough,
  finishedReadThroughs,
  isCurrentReadThroughPosition,
  normalizeReadThroughId,
  planEditFinishDate,
  planFirstPageTurn,
  planMarkCompleted,
  planRemoveReadThrough,
  planSetStatus,
  planStartOver,
  positionReadThroughId,
  readThroughOfDay,
  startOverToApply,
  type BookState,
  type BookStateWrite,
  type ReadThrough
} from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

const BOOK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';

function rec(
  kind: string,
  id: string,
  data: Record<string, unknown>,
  deleted = false
): LocalRecord {
  return {
    kind,
    id,
    bookId: id.split(':')[0],
    deviceId: DEVICE,
    updatedAt: 1,
    deletedAt: deleted ? 1 : null,
    rev: 1,
    data
  };
}

function rtRecord(number: number, extra: Partial<ReadThrough> = {}): LocalRecord {
  return rec('read-through', `${BOOK}:${number}`, {
    number,
    origin: 'start-over',
    startedOn: '2026-11-01',
    finished: false,
    finishedOn: null,
    manual: false,
    charCount: null,
    ...extra
  });
}

/** Applies planned writes to a record list (as the mirror would). */
function apply(records: LocalRecord[], writes: BookStateWrite[]): LocalRecord[] {
  const out = [...records];
  for (const w of writes) {
    const i = out.findIndex((r) => r.kind === w.kind && r.id === w.id);
    const next = rec(w.kind, w.id, 'data' in w ? w.data : {}, 'deleted' in w);
    if (i >= 0) out[i] = next;
    else out.push(next);
  }
  return out;
}

const state = (records: LocalRecord[]): BookState => bookStateFrom(BOOK, records);

describe('bookStateFrom', () => {
  it('defaults to unread, not favorite, inherit, no read-throughs', () => {
    expect(state([])).toEqual({
      bookId: BOOK,
      status: 'unread',
      statusAuto: false,
      favorite: false,
      blur: 'inherit',
      readThroughs: []
    });
  });

  it('reads every kind, ignores other books, deleted and unknown values', () => {
    const s = state([
      rec('book-status', BOOK, { status: 'reading', auto: true }),
      rec('book-favorite', BOOK, { favorite: true }),
      rec('book-blur', BOOK, { blur: 'always' }),
      rec('book-status', OTHER, { status: 'dropped', auto: false }),
      rtRecord(3),
      rtRecord(2, { finished: true, finishedOn: '2026-11-05' }),
      rtRecord(4, {}),
      { ...rtRecord(5), deletedAt: 2 },
      rec('position', `${BOOK}:${DEVICE}`, { charPos: 5 })
    ]);
    expect(s.status).toBe('reading');
    expect(s.statusAuto).toBe(true);
    expect(s.favorite).toBe(true);
    expect(s.blur).toBe('always');
    expect(s.readThroughs.map((r) => r.number)).toEqual([2, 3, 4]);
    expect(currentReadThrough(s)?.number).toBe(4);
    expect(finishedReadThroughs(s)).toBe(1);
    expect(state([rec('book-status', BOOK, { status: 'planned' })]).status).toBe('unread');
  });

  it('groups all mirrored records by book', () => {
    const states = bookStatesFrom([
      rec('book-favorite', BOOK, { favorite: true }),
      rec('book-status', OTHER, { status: 'dropped', auto: false })
    ]);
    expect(states.get(BOOK)?.favorite).toBe(true);
    expect(states.get(OTHER)?.status).toBe('dropped');
  });
});

describe('transitions', () => {
  it('first page turn: unread or no record becomes reading (auto); others stay', () => {
    expect(planFirstPageTurn(state([]))).toEqual([
      { kind: 'book-status', id: BOOK, bookId: BOOK, data: { status: 'reading', auto: true } }
    ]);
    for (const status of ['reading', 'completed', 'dropped']) {
      expect(planFirstPageTurn(state([rec('book-status', BOOK, { status, auto: false })]))).toEqual(
        []
      );
    }
  });

  it('first page turn never touches read-throughs', () => {
    const writes = planFirstPageTurn(state([rtRecord(2)]));
    expect(writes.every((w) => w.kind === 'book-status')).toBe(true);
  });

  it('set status changes only the status', () => {
    expect(planSetStatus(state([]), 'dropped')).toEqual([
      { kind: 'book-status', id: BOOK, bookId: BOOK, data: { status: 'dropped', auto: false } }
    ]);
    expect(
      planSetStatus(
        state([rec('book-status', BOOK, { status: 'dropped', auto: false })]),
        'dropped'
      )
    ).toEqual([]);
    // Confirming an automatic status makes it manual.
    expect(
      planSetStatus(state([rec('book-status', BOOK, { status: 'reading', auto: true })]), 'reading')
    ).toHaveLength(1);
    expect(() => planSetStatus(state([]), 'completed')).toThrow();
  });

  it('mark completed without read-throughs creates a finished manual #1', () => {
    const writes = planMarkCompleted(state([]), {
      finishedOn: '2026-10-01',
      manual: true,
      charCount: 120000
    });
    expect(writes).toEqual([
      { kind: 'book-status', id: BOOK, bookId: BOOK, data: { status: 'completed', auto: false } },
      {
        kind: 'read-through',
        id: `${BOOK}:1`,
        bookId: BOOK,
        data: {
          number: 1,
          origin: 'completion',
          startedOn: null,
          finished: true,
          finishedOn: '2026-10-01',
          manual: true,
          charCount: 120000
        }
      }
    ]);
  });

  it('mark completed with a blank date', () => {
    const writes = planMarkCompleted(state([]), {
      finishedOn: null,
      manual: true,
      charCount: null
    });
    expect(writes[1]).toMatchObject({ data: { finished: true, finishedOn: null } });
    const bad = planMarkCompleted(state([]), {
      finishedOn: '1.10.2026',
      manual: true,
      charCount: 1
    });
    expect(bad[1]).toMatchObject({ data: { finishedOn: null } });
  });

  it('mark completed finishes the open read-through, keeping its start', () => {
    const writes = planMarkCompleted(state([rtRecord(2, { startedOn: '2026-11-01' })]), {
      finishedOn: '2026-11-08',
      manual: true,
      charCount: 5000
    });
    expect(writes[1]).toEqual({
      kind: 'read-through',
      id: `${BOOK}:2`,
      bookId: BOOK,
      data: {
        number: 2,
        origin: 'start-over',
        startedOn: '2026-11-01',
        finished: true,
        finishedOn: '2026-11-08',
        manual: true,
        charCount: 5000
      }
    });
  });

  it('marking completed again only sets the status (no second read-through)', () => {
    let records: LocalRecord[] = [];
    records = apply(
      records,
      planMarkCompleted(state(records), { finishedOn: null, manual: true, charCount: 1 })
    );
    expect(
      planMarkCompleted(state(records), { finishedOn: '2026-11-09', manual: true, charCount: 1 })
    ).toEqual([]);
    // After a manual status change away from Completed, marking again only changes the status.
    records = apply(records, planSetStatus(state(records), 'reading'));
    const again = planMarkCompleted(state(records), {
      finishedOn: null,
      manual: true,
      charCount: 1
    });
    expect(again.map((w) => w.kind)).toEqual(['book-status']);
    expect(finishedReadThroughs(state(apply(records, again)))).toBe(1);
  });

  it("the reader's Complete Book finishes as tracked (not manual), without a char count", () => {
    const writes = planMarkCompleted(state([]), {
      finishedOn: '2026-11-09',
      manual: false,
      charCount: 99
    });
    expect(writes[1]).toMatchObject({ data: { manual: false, charCount: null, finished: true } });
  });

  it('start over: next number after the implicit #1, open, status unread', () => {
    expect(planStartOver(state([]), '2026-11-09')).toEqual([
      {
        kind: 'read-through',
        id: `${BOOK}:2`,
        bookId: BOOK,
        data: {
          number: 2,
          origin: 'start-over',
          startedOn: '2026-11-09',
          finished: false,
          finishedOn: null,
          manual: false,
          charCount: null
        }
      },
      { kind: 'book-status', id: BOOK, bookId: BOOK, data: { status: 'unread', auto: false } }
    ]);
    expect(
      planStartOver(state([rtRecord(1, { origin: 'completion', finished: true })]), '2026-11-09')[0]
        .id
    ).toBe(`${BOOK}:2`);
    expect(planStartOver(state([rtRecord(2), rtRecord(3)]), '2026-11-09')[0].id).toBe(`${BOOK}:4`);
  });

  it('start over made on two devices offline produces the same record id', () => {
    const records = [rtRecord(1, { origin: 'completion', finished: true })];
    const a = planStartOver(state(records), '2026-11-09');
    const b = planStartOver(state(records), '2026-11-10');
    expect(a[0].id).toBe(b[0].id);
  });

  it('a full cycle: completed -> start over -> reading -> completed = read 2x', () => {
    let records: LocalRecord[] = [];
    records = apply(
      records,
      planMarkCompleted(state(records), { finishedOn: '2026-01-01', manual: true, charCount: 10 })
    );
    records = apply(records, planStartOver(state(records), '2026-11-01'));
    expect(state(records).status).toBe('unread');
    records = apply(records, planFirstPageTurn(state(records)));
    expect(state(records).status).toBe('reading');
    records = apply(
      records,
      planMarkCompleted(state(records), {
        finishedOn: '2026-11-09',
        manual: false,
        charCount: null
      })
    );
    const s = state(records);
    expect(s.status).toBe('completed');
    expect(finishedReadThroughs(s)).toBe(2);
    expect(s.readThroughs.map((r) => [r.number, r.manual])).toEqual([
      [1, true],
      [2, false]
    ]);
  });

  it('edit finish date and remove (completion read-throughs only)', () => {
    const records = [
      rtRecord(1, { origin: 'completion', finished: true, finishedOn: null, manual: true }),
      rtRecord(2)
    ];
    expect(planEditFinishDate(state(records), `${BOOK}:1`, '2026-02-03')[0]).toMatchObject({
      data: { finishedOn: '2026-02-03', finished: true, manual: true }
    });
    expect(planEditFinishDate(state(records), `${BOOK}:2`, '2026-02-03')).toEqual([]);
    expect(planRemoveReadThrough(state(records), `${BOOK}:1`)).toEqual([
      { kind: 'read-through', id: `${BOOK}:1`, bookId: BOOK, deleted: true }
    ]);
    expect(planRemoveReadThrough(state(records), `${BOOK}:2`)).toEqual([]);
  });
});

describe('positions and Start over', () => {
  const position = (readThroughId: unknown) =>
    rec('position', `${BOOK}:${DEVICE}`, { charPos: 500, progress: 0.5, readThroughId });

  it('null means the first read-through', () => {
    expect(normalizeReadThroughId(BOOK, null)).toBe(`${BOOK}:1`);
    expect(normalizeReadThroughId(BOOK, `${BOOK}:3`)).toBe(`${BOOK}:3`);
    expect(positionReadThroughId(state([]))).toBeNull();
    expect(positionReadThroughId(state([rtRecord(2)]))).toBe(`${BOOK}:2`);
  });

  it('positions belong to the current read-through by id', () => {
    expect(isCurrentReadThroughPosition(state([]), position(null))).toBe(true);
    expect(
      isCurrentReadThroughPosition(
        state([rtRecord(1, { origin: 'completion', finished: true })]),
        position(null)
      )
    ).toBe(true);
    expect(isCurrentReadThroughPosition(state([rtRecord(2)]), position(null))).toBe(false);
    expect(isCurrentReadThroughPosition(state([rtRecord(2)]), position(`${BOOK}:2`))).toBe(true);
  });

  it('start over applies once per device, only for an open start-over read-through', () => {
    const started = state([rtRecord(2)]);
    expect(startOverToApply(started, position(null), 500)?.number).toBe(2);
    expect(startOverToApply(started, undefined, 500)?.number).toBe(2);
    expect(startOverToApply(started, position(`${BOOK}:2`), 500)).toBeNull();
    expect(startOverToApply(started, position(null), 0)).toBeNull();
    expect(startOverToApply(state([]), position(null), 500)).toBeNull();
    expect(
      startOverToApply(
        state([rtRecord(1, { origin: 'completion', finished: true })]),
        undefined,
        500
      )
    ).toBeNull();
    expect(
      startOverToApply(state([rtRecord(2, { finished: true })]), position(null), 500)
    ).toBeNull();
    // A deleted own record counts as none.
    expect(startOverToApply(started, { ...position(`${BOOK}:2`), deletedAt: 5 }, 500)?.number).toBe(
      2
    );
  });
});

describe('stat days and character totals', () => {
  const rt = (number: number, extra: Partial<ReadThrough> = {}): ReadThrough =>
    bookStateFrom(BOOK, [rtRecord(number, extra)]).readThroughs[0];
  const day = (dateKey: string, charactersRead: number, readingTime = 60) => ({
    dateKey,
    charactersRead,
    readingTime
  });

  it('days belong to the read-through that started on or before them', () => {
    const list = [
      rt(1, { startedOn: null, origin: 'completion' }),
      rt(2, { startedOn: '2026-11-05' })
    ];
    expect(readThroughOfDay(list, '2026-01-01')?.number).toBe(1);
    expect(readThroughOfDay(list, '2026-11-04')?.number).toBe(1);
    // The Start-over day belongs to the new read-through.
    expect(readThroughOfDay(list, '2026-11-05')?.number).toBe(2);
    expect(readThroughOfDay(list, '2026-12-01')?.number).toBe(2);
    // Before any explicit start: the implicit first read-through.
    expect(readThroughOfDay([rt(2, { startedOn: '2026-11-05' })], '2026-11-01')).toBeNull();
  });

  it('tracked only: characters and time from the days', () => {
    expect(
      characterTotals([], [day('2026-11-01', 100, 30), day('2026-11-02', 50, 20)], 1000)
    ).toEqual({
      characters: 150,
      trackedCharacters: 150,
      readingTime: 50,
      completed: 0,
      manualCompleted: 0
    });
  });

  it('a manual completion replaces the tracked characters of its days (no double count)', () => {
    const manual = rt(1, {
      origin: 'completion',
      startedOn: null,
      finished: true,
      manual: true,
      charCount: 1000
    });
    const totals = characterTotals([manual], [day('2026-11-01', 300, 600)], 999);
    expect(totals).toEqual({
      characters: 1000,
      trackedCharacters: 0,
      readingTime: 600,
      completed: 1,
      manualCompleted: 1
    });
  });

  it('days of a later tracked read-through still count; the catalog count is the fallback', () => {
    const list = [
      rt(1, {
        origin: 'completion',
        startedOn: null,
        finished: true,
        manual: true,
        charCount: null
      }),
      rt(2, { startedOn: '2026-11-05', finished: true, manual: false })
    ];
    const totals = characterTotals(list, [day('2026-11-01', 300), day('2026-11-06', 400)], 800);
    expect(totals.characters).toBe(800 + 400);
    expect(totals.trackedCharacters).toBe(400);
    expect(totals.readingTime).toBe(120);
    expect(totals.completed).toBe(2);
    expect(totals.manualCompleted).toBe(1);
  });

  it('an unfinished manual flag never counts', () => {
    const totals = characterTotals([rt(2, { manual: true, finished: false, charCount: 5 })], [], 9);
    expect(totals.characters).toBe(0);
  });
});
