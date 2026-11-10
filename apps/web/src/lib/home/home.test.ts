/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { BookState } from '$lib/sync/book-state';
import { bookStateFrom } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import { continueReadingIds } from './continue-reading';
import { appOpenPath, leavingForgetsLastBook } from './open-target';
import {
  DEFAULT_HOME_ROWS,
  isPinned,
  moveRow,
  normalizeRows,
  pinRow,
  rowHref,
  rowTitle,
  setRowHidden,
  unpinRow,
  type HomeRow
} from './rows';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';

function position(
  bookId: string,
  device: string,
  updatedAt: number,
  data: { charPos: number; progress: number; readThroughId?: string | null }
): LocalRecord {
  return {
    kind: 'position',
    id: `${bookId}:${device}`,
    bookId,
    deviceId: device,
    updatedAt,
    deletedAt: null,
    rev: 1,
    data: { readThroughId: null, ...data }
  };
}

function state(bookId: string, status: BookState['status']): BookState {
  return { ...bookStateFrom(bookId, []), status };
}

describe('Home rows', () => {
  it('defaults to Continue reading, then a hidden Recently added', () => {
    expect(normalizeRows(undefined)).toEqual(DEFAULT_HOME_ROWS);
    expect(normalizeRows([])).toEqual(DEFAULT_HOME_ROWS);
  });

  it('drops unreadable and repeated entries and keeps the two fixed rows', () => {
    const rows = normalizeRows([
      { type: 'author', ref: '著者一', hidden: false },
      { type: 'author', ref: '著者一', hidden: true },
      { type: 'builtin', ref: 'no-such-list' },
      { type: 'series' },
      'junk',
      { type: 'recent', hidden: false }
    ]);
    expect(rows).toEqual([
      { type: 'continue', hidden: false },
      { type: 'author', ref: '著者一', hidden: false },
      { type: 'recent', hidden: false }
    ]);
  });

  it('pins, shows a hidden pin again, unpins, moves and hides', () => {
    let rows: HomeRow[] = normalizeRows([]);
    const fav = { type: 'builtin', ref: 'favorites' } as const;
    rows = pinRow(rows, fav);
    rows = pinRow(rows, { type: 'series', ref: 'シリーズ' });
    expect(isPinned(rows, fav)).toBe(true);
    expect(rows.map((r) => r.type)).toEqual(['continue', 'recent', 'builtin', 'series']);
    rows = setRowHidden(rows, 2, true);
    expect(isPinned(rows, fav)).toBe(false);
    rows = pinRow(rows, fav);
    expect(rows[2]).toEqual({ type: 'builtin', ref: 'favorites', hidden: false });
    rows = moveRow(rows, 3, -3);
    expect(rows.map((r) => r.type)).toEqual(['series', 'continue', 'recent', 'builtin']);
    expect(moveRow(rows, 0, -1)).toEqual(rows);
    rows = unpinRow(rows, fav);
    expect(rows.map((r) => r.type)).toEqual(['series', 'continue', 'recent']);
  });

  it('names rows and links them to their full view', () => {
    const names = (id: string) => (id === 'c1' ? 'Planned' : null);
    expect(rowTitle({ type: 'collection', ref: 'c1', hidden: false }, names)).toBe('Planned');
    expect(rowTitle({ type: 'collection', ref: 'gone', hidden: false }, names)).toBe(
      'Deleted collection'
    );
    expect(rowTitle({ type: 'builtin', ref: 'reading', hidden: false })).toBe('Reading');
    expect(rowHref({ type: 'continue', hidden: false }, '')).toBeNull();
    expect(rowHref({ type: 'author', ref: '著者 一', hidden: false }, '/x')).toBe(
      '/x/library?tab=authors&group=%E8%91%97%E8%80%85+%E4%B8%80'
    );
    expect(rowHref({ type: 'builtin', ref: 'favorites', hidden: false }, '')).toBe(
      '/library?collection=favorites'
    );
  });
});

describe('Continue reading', () => {
  it('lists books with a place past the start, newest activity on any device first', () => {
    const positions = new Map([
      [A, [position(A, 'd1', 100, { charPos: 50, progress: 0.1 })]],
      [
        B,
        [
          position(B, 'd1', 50, { charPos: 900, progress: 0.9 }),
          position(B, 'd2', 300, { charPos: 10, progress: 0.01 })
        ]
      ],
      [C, [position(C, 'd1', 400, { charPos: 0, progress: 0 })]]
    ]);
    expect(continueReadingIds(new Map(), positions, 20)).toEqual([B, A]);
    expect(continueReadingIds(new Map(), positions, 1)).toEqual([B]);
  });

  it('leaves out Completed and Dropped books and adds Reading books without a place last', () => {
    const positions = new Map([
      [A, [position(A, 'd1', 100, { charPos: 50, progress: 0.1 })]],
      [B, [position(B, 'd1', 200, { charPos: 50, progress: 0.1 })]],
      [C, [position(C, 'd1', 300, { charPos: 50, progress: 0.1 })]]
    ]);
    const states = new Map([
      [B, state(B, 'completed')],
      [C, state(C, 'dropped')],
      [D, state(D, 'reading')]
    ]);
    expect(continueReadingIds(states, positions, 20)).toEqual([A, D]);
  });

  it("ignores places from before Start over (the current read hasn't started)", () => {
    const records: LocalRecord[] = [
      {
        kind: 'read-through',
        id: `${A}:2`,
        bookId: A,
        deviceId: 'd1',
        updatedAt: 500,
        deletedAt: null,
        rev: 1,
        data: {
          number: 2,
          origin: 'start-over',
          startedOn: '2026-11-10',
          finished: false,
          finishedOn: null,
          manual: false,
          charCount: null
        }
      }
    ];
    const started = { ...bookStateFrom(A, records), status: 'unread' as const };
    const positions = new Map([[A, [position(A, 'd1', 100, { charPos: 500, progress: 0.5 })]]]);
    expect(continueReadingIds(new Map([[A, started]]), positions, 20)).toEqual([]);
  });
});

describe('opening the app', () => {
  it('jumps into the last book by default and opens Home otherwise', () => {
    expect(appOpenPath('last-book', 12, '')).toBe('/b?id=12');
    expect(appOpenPath('last-book', undefined, '')).toBe('/home');
    expect(appOpenPath('home', 12, '/base')).toBe('/base/home');
    expect(appOpenPath('', 3, '')).toBe('/b?id=3');
  });

  it('forgets the last book when leaving for the lists, not for Settings or Statistics', () => {
    expect(leavingForgetsLastBook('/home')).toBe(true);
    expect(leavingForgetsLastBook('/library')).toBe(true);
    expect(leavingForgetsLastBook('/collections')).toBe(true);
    expect(leavingForgetsLastBook('/manage')).toBe(true);
    expect(leavingForgetsLastBook('/settings')).toBe(false);
    expect(leavingForgetsLastBook('/statistics')).toBe(false);
  });
});
