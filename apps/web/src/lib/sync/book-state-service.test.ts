/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  getAllBookStates,
  getBookState,
  markBooksCompleted,
  noteFirstPageTurn,
  noteReaderCompletion,
  onBookStatesChanged,
  pendingStartOver,
  removeReadThrough,
  setBookBlur,
  setBookFavorite,
  setBookStatus,
  startBookOver,
  type BookStateDeps
} from './book-state-service';
import { openSyncDb } from './sync-db';
import { SyncEngine } from './sync-engine';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '11111111-1111-4111-8111-111111111111';

let run = 0;
async function deps(): Promise<BookStateDeps & { engine: SyncEngine; warnings: string[] }> {
  run += 1;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(`book-state-service-${run}`),
    newId: () => DEVICE
  });
  const warnings: string[] = [];
  return {
    engine,
    getEngine: async () => engine,
    today: () => '2026-11-09',
    warn: (m) => warnings.push(m),
    warnings
  };
}

describe('book state service', () => {
  it('saves status, favorite and blur as separate records', async () => {
    const d = await deps();
    await setBookStatus(A, 'dropped', d);
    await setBookFavorite(A, true, d);
    await setBookBlur(A, 'never', d);
    expect(await getBookState(A, d)).toMatchObject({
      status: 'dropped',
      favorite: true,
      blur: 'never',
      readThroughs: []
    });
    const kinds = (await d.engine.getForBook(A)).map((r) => r.kind).sort();
    expect(kinds).toEqual(['book-blur', 'book-favorite', 'book-status']);
  });

  it('bulk mark completed: one date, the catalog count per book', async () => {
    const d = await deps();
    const failed = await markBooksCompleted(
      [
        { bookId: A, charCount: 1000 },
        { bookId: B, charCount: null }
      ],
      '2026-10-01',
      d
    );
    expect(failed).toEqual([]);
    const states = await getAllBookStates(d);
    expect(states.get(A)?.readThroughs[0]).toMatchObject({
      number: 1,
      finished: true,
      finishedOn: '2026-10-01',
      manual: true,
      charCount: 1000
    });
    expect(states.get(B)?.status).toBe('completed');
    expect(states.get(B)?.readThroughs[0].charCount).toBeNull();
  });

  it('first page turn, reader completion and start over', async () => {
    const d = await deps();
    await noteFirstPageTurn(A, d);
    expect((await getBookState(A, d)).status).toBe('reading');
    await noteReaderCompletion(A, d);
    let s = await getBookState(A, d);
    expect(s.status).toBe('completed');
    expect(s.readThroughs[0]).toMatchObject({ finishedOn: '2026-11-09', manual: false });
    await startBookOver(A, d);
    s = await getBookState(A, d);
    expect(s.status).toBe('unread');
    expect(s.readThroughs.map((r) => [r.number, r.origin, r.startedOn])).toEqual([
      [1, 'completion', null],
      [2, 'start-over', '2026-11-09']
    ]);
    // A completion read-through can be removed; a start-over one can't.
    await removeReadThrough(A, `${A}:2`, d);
    await removeReadThrough(A, `${A}:1`, d);
    expect((await getBookState(A, d)).readThroughs.map((r) => r.number)).toEqual([2]);
  });

  it('pending start over uses this device’s own position record', async () => {
    const d = await deps();
    await startBookOver(A, d);
    expect((await pendingStartOver(A, 500, d))?.number).toBe(2);
    // Saving a place in the new read-through settles it.
    await d.engine.put(
      'position',
      `${A}:${DEVICE}`,
      { charPos: 0, progress: 0, readThroughId: `${A}:2` },
      { bookId: A }
    );
    expect(await pendingStartOver(A, 500, d)).toBeNull();
  });

  it('never writes stat-day or position records', async () => {
    const d = await deps();
    await noteFirstPageTurn(A, d);
    await markBooksCompleted([{ bookId: A, charCount: 5 }], null, d);
    await startBookOver(A, d);
    await setBookFavorite(A, true, d);
    const kinds = new Set((await d.engine.getForBook(A)).map((r) => r.kind));
    expect(kinds.has('stat-day')).toBe(false);
    expect(kinds.has('position')).toBe(false);
  });

  it('reports changed books to subscribers', async () => {
    const d = await deps();
    const seen: string[][] = [];
    const off = await onBookStatesChanged((ids) => seen.push([...ids]), d);
    await setBookFavorite(B, true, d);
    await d.engine.put('position', `${A}:${DEVICE}`, { charPos: 1, progress: 0 }, { bookId: A });
    off();
    await setBookFavorite(A, true, d);
    expect(seen).toEqual([[B]]);
  });

  it('reader hooks never throw', async () => {
    const warnings: string[] = [];
    const broken: BookStateDeps = {
      getEngine: async () => {
        throw new Error('no indexeddb');
      },
      today: () => '2026-11-09',
      warn: (m) => warnings.push(m)
    };
    await expect(noteFirstPageTurn(A, broken)).resolves.toBeUndefined();
    await expect(noteReaderCompletion(A, broken)).resolves.toBeUndefined();
    await expect(pendingStartOver(A, 5, broken)).resolves.toBeNull();
    expect(warnings).toHaveLength(3);
    // User actions report the failure instead.
    await expect(setBookStatus(A, 'dropped', broken)).rejects.toThrow('no indexeddb');
    expect(await markBooksCompleted([{ bookId: A, charCount: 1 }], null, broken)).toEqual([A]);
  });
});
