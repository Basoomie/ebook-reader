/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { BookState } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  entryFrom,
  listsByBook,
  mayApplyQuietly,
  planChanges,
  type AppliedRecord,
  type BookmeterEntry,
  type StatusInfo
} from './plan';

const A = '11111111-1111-1111-1111-111111111111';

function entry(p: Partial<BookmeterEntry> & { target: string | null }): BookmeterEntry {
  return {
    id: `${A}:${p.listing ?? '1'}`,
    account: A,
    listing: '1',
    list: 'read',
    date: '2026-10-17',
    title: 'T',
    authors: [],
    cover: null,
    rank: 1,
    books: p.target ? [p.target] : [],
    statuses: true,
    wish: true,
    ...p
  };
}

function state(bookId: string, p: Partial<BookState> = {}): BookState {
  return {
    bookId,
    status: 'unread',
    statusAuto: false,
    favorite: false,
    blur: 'inherit',
    readThroughs: [],
    ...p
  };
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const at = (day: string) => Date.parse(`${day}T12:00:00Z`);

function plan(
  entries: BookmeterEntry[],
  states: BookState[] = [],
  info: [string, StatusInfo][] = [],
  applied: AppliedRecord[] = []
) {
  return planChanges({
    entries,
    states: new Map(states.map((s) => [s.bookId, s])),
    statusInfo: new Map(info),
    applied: new Map(applied.map((a) => [a.bookId, a])),
    dayOf
  });
}

describe('planChanges', () => {
  it('completes a read book on its Bookmeter date; leaves a Completed one', () => {
    const changes = plan([entry({ target: 'b1' })]);
    expect(changes).toEqual([
      expect.objectContaining({
        bookId: 'b1',
        kind: 'complete',
        date: '2026-10-17',
        from: 'unread'
      })
    ]);
    expect(plan([entry({ target: 'b1' })], [state('b1', { status: 'completed' })])).toEqual([]);
  });

  it('lets the reader’s own later status win, but not an older one or an automatic one', () => {
    const e = entry({ target: 'b1' });
    const s = state('b1', { status: 'reading' });
    // Reading set by hand after the read date (or that day): kept.
    expect(plan([e], [s], [['b1', { updatedAt: at('2026-10-20'), auto: false }]])).toEqual([]);
    expect(plan([e], [s], [['b1', { updatedAt: at('2026-10-17'), auto: false }]])).toEqual([]);
    // Set by hand before it: completed.
    expect(plan([e], [s], [['b1', { updatedAt: at('2026-10-01'), auto: false }]])).toHaveLength(1);
    // The reader's first page turn (automatic) never holds it back.
    expect(plan([e], [s], [['b1', { updatedAt: at('2026-11-01'), auto: true }]])).toHaveLength(1);
    // No date on Bookmeter and a status of the user's own: kept.
    expect(
      plan([entry({ target: 'b1', date: null })], [s], [['b1', { updatedAt: 1, auto: false }]])
    ).toEqual([]);
  });

  it('marks Reading only an Unread book with no status of the user’s own', () => {
    const e = entry({ target: 'b1', list: 'reading', date: null });
    expect(plan([e])).toEqual([expect.objectContaining({ kind: 'reading' })]);
    expect(plan([e], [state('b1')], [['b1', { updatedAt: 5, auto: false }]])).toEqual([]);
    expect(plan([e], [state('b1', { status: 'dropped' })])).toEqual([]);
  });

  it('never plans the same change twice, but a later read again', () => {
    const done: AppliedRecord = {
      bookId: 'b1',
      account: A,
      listing: '1',
      list: 'read',
      date: '2026-10-17',
      outcome: 'skipped',
      at: 1
    };
    expect(plan([entry({ target: 'b1' })], [], [], [done])).toEqual([]);
    expect(plan([entry({ target: 'b1', date: '2026-11-20' })], [], [], [done])).toHaveLength(1);
  });

  it('a change left unticked in Review waits there and is never applied quietly', () => {
    const held: AppliedRecord = {
      bookId: 'b1',
      account: A,
      listing: '1',
      list: 'read',
      date: '2026-10-17',
      outcome: 'held',
      at: 1
    };
    const changes = plan([entry({ target: 'b1' })], [], [], [held]);
    expect(changes).toEqual([expect.objectContaining({ bookId: 'b1', held: true })]);
    expect(mayApplyQuietly(changes, new Set([A]), 10)).toBe(false);
    // A later read of the same book is a new change.
    const later = plan([entry({ target: 'b1', date: '2026-11-20' })], [], [], [held]);
    expect(later).toEqual([expect.objectContaining({ held: false })]);
  });

  it('a finish already recorded that day is not made again', () => {
    const s = state('b1', {
      status: 'reading',
      readThroughs: [
        {
          number: 1,
          origin: 'completion',
          startedOn: null,
          finished: true,
          finishedOn: '2026-10-17',
          manual: false,
          charCount: null
        }
      ] as BookState['readThroughs']
    });
    expect(plan([entry({ target: 'b1' })], [s])).toEqual([]);
  });

  it('one change per book: read beats reading, the latest date wins; off accounts and books without a copy change nothing', () => {
    const changes = plan([
      entry({ target: 'b1', listing: '1', list: 'reading', date: null }),
      entry({ target: 'b1', listing: '2', date: '2025-01-01' }),
      entry({ target: 'b1', listing: '3', date: '2026-01-01' }),
      entry({ target: 'b2', listing: '4', statuses: false }),
      entry({ target: null, listing: '5' }),
      entry({ target: 'b3', listing: '6', list: 'wish', date: null })
    ]);
    expect(changes.map((c) => [c.bookId, c.entry.listing])).toEqual([['b1', '3']]);
  });
});

describe('the rest', () => {
  it('applies quietly only after a review and below the limit', () => {
    const c = plan([entry({ target: 'b1' })]);
    expect(mayApplyQuietly(c, new Set(), 10)).toBe(false);
    expect(mayApplyQuietly(c, new Set([A]), 10)).toBe(true);
    expect(mayApplyQuietly(c, new Set([A]), 0)).toBe(false);
    expect(mayApplyQuietly([], new Set([A]), 10)).toBe(false);
  });

  it('reads entry records and lists every copy’s lists', () => {
    const r: LocalRecord = {
      kind: 'bookmeter-entry',
      id: `${A}:9`,
      bookId: null,
      deviceId: 'd',
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      data: { account: A, listing: '9', list: 'wish', date: null, books: ['x', 'y'], target: 'x' }
    };
    const e = entryFrom(r)!;
    expect(e).toMatchObject({ list: 'wish', books: ['x', 'y'], target: 'x', statuses: true });
    expect(entryFrom({ ...r, deletedAt: 2 })).toBeNull();
    expect(entryFrom({ ...r, data: { ...r.data, list: 'nope' } })).toBeNull();
    expect([...(listsByBook([e]).get('y') ?? [])]).toEqual(['wish']);
  });
});
