/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { BookState, BookStatus } from '$lib/sync/book-state';
import {
  finishedOf,
  hideRecordId,
  nextInSeries,
  volumeKind,
  type NextBook,
  type NextState
} from './next-in-series';

interface FixtureCase {
  name: string;
  books: {
    id: string;
    library: string;
    series: string | null;
    index: number | null;
    added?: number;
    missing?: boolean;
  }[];
  status?: Record<string, BookStatus>;
  finished?: Record<string, string | null>;
  hidden?: [string, string][];
  settings?: { on?: boolean; bonus?: boolean };
  next: string[];
}

// The server's SQL runs the same file (apps/storage-server/tests/next-in-series.test.ts).
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../storage-server/tests/fixtures/next-in-series.json'),
    'utf8'
  )
) as { cases: FixtureCase[] };

function run(c: FixtureCase): string[] {
  if (c.settings?.on === false) return [];
  const books: NextBook[] = c.books.map((b, i) => ({
    id: b.id,
    libraryId: b.library,
    series: b.series === null ? null : { name: b.series, index: b.index },
    addedAt: b.added ?? i,
    // Library D is disabled.
    visible: !b.missing && b.library !== 'D'
  }));
  const hidden = new Set((c.hidden ?? []).map(([lib, name]) => hideRecordId(lib, name)));
  const stateOf = (id: string): NextState => {
    const finishedOn = c.finished?.[id];
    const status = c.status?.[id] ?? 'unread';
    return {
      status,
      finished: status === 'completed' || finishedOn !== undefined,
      finishedAt: finishedOn ? Date.parse(`${finishedOn}T00:00:00Z`) : 0
    };
  };
  return nextInSeries(books, stateOf, {
    bonus: c.settings?.bonus === true,
    hidden: (lib, name) => hidden.has(hideRecordId(lib, name))
  }).map((e) => e.bookId);
}

describe('next in your series: the shared fixture', () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      expect(run(c).sort()).toEqual([...c.next].sort());
    });
  }
});

describe('next in your series', () => {
  it('names volume kinds by their number', () => {
    expect(volumeKind(3)).toBe('main');
    expect(volumeKind(3.1)).toBe('bonus');
    expect(volumeKind(3.5)).toBe('side');
    expect(volumeKind(3.9)).toBe('omnibus');
    expect(volumeKind(0.9)).toBe('omnibus');
  });

  it('orders by the series finished last', () => {
    const books: NextBook[] = ['a1', 'a2', 'b1', 'b2'].map((id) => ({
      id,
      libraryId: 'L',
      series: { name: id[0], index: Number(id[1]) },
      addedAt: 0,
      visible: true
    }));
    const at: Record<string, number> = { a1: 10, b1: 20 };
    const got = nextInSeries(
      books,
      (id) => ({
        status: at[id] ? 'completed' : 'unread',
        finished: !!at[id],
        finishedAt: at[id] ?? 0
      }),
      { bonus: false, hidden: () => false }
    );
    expect(got).toEqual([
      { bookId: 'b2', finishedAt: 20 },
      { bookId: 'a2', finishedAt: 10 }
    ]);
  });

  it('reads finished from status or a finished read-through', () => {
    const base = { bookId: 'x', statusAuto: false, favorite: false, blur: 'inherit' } as const;
    const rt = (finished: boolean, finishedOn: string | null) => ({
      id: 'x:1',
      number: 1,
      origin: 'completion' as const,
      startedOn: null,
      finished,
      finishedOn,
      manual: false,
      charCount: null
    });
    expect(finishedOf(undefined)).toEqual({ finished: false, finishedAt: 0 });
    expect(
      finishedOf({ ...base, status: 'completed', readThroughs: [] } as unknown as BookState)
    ).toEqual({ finished: true, finishedAt: 0 });
    expect(
      finishedOf({
        ...base,
        status: 'reading',
        readThroughs: [rt(true, '2026-11-02'), rt(false, null)]
      } as unknown as BookState)
    ).toEqual({ finished: true, finishedAt: Date.UTC(2026, 10, 2) });
  });

  it('gives a series the same hide id everywhere', () => {
    expect(hideRecordId('L', 'S')).toMatch(/^[0-9a-f]{16}$/);
    expect(hideRecordId('L', 'S')).toBe(hideRecordId('L', 'S'));
    expect(hideRecordId('L', 'S')).not.toBe(hideRecordId('M', 'S'));
  });
});
