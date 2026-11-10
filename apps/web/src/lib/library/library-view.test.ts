/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LibraryApi, LibraryApiError } from './api';
import { isCoverBlurred } from './cover-blur';
import { bookProgressLabel, furthestPosition, positionsByBook, seriesReadCount } from './progress';
import { bookStateFrom, type BookState } from '$lib/sync/book-state';
import {
  getAllBookStates,
  setBooksBlur,
  setBooksFavorite,
  setBooksStatus,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { openSyncDb, type LocalRecord } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';
import { getTagBlurRules, setTagBlur, TAG_BLUR_KIND } from '$lib/sync/tag-blur';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '11111111-1111-4111-8111-111111111111';

describe('cover blur', () => {
  const rules = new Set(['BL', 'ホラー']);

  it("lets the book's own setting win over tag rules", () => {
    expect(isCoverBlurred('always', [], rules)).toBe(true);
    expect(isCoverBlurred('never', ['BL'], rules)).toBe(false);
  });

  it('follows tag rules otherwise', () => {
    expect(isCoverBlurred('inherit', ['SF', 'ホラー'], rules)).toBe(true);
    expect(isCoverBlurred(undefined, ['BL'], rules)).toBe(true);
    expect(isCoverBlurred(undefined, ['SF'], rules)).toBe(false);
    expect(isCoverBlurred('inherit', [], new Set())).toBe(false);
  });
});

function position(
  bookId: string,
  device: string,
  updatedAt: number,
  data: Record<string, unknown>
): LocalRecord {
  return {
    kind: 'position',
    id: `${bookId}:${device}`,
    bookId,
    deviceId: device,
    updatedAt,
    deletedAt: null,
    rev: 1,
    data
  };
}

describe('progress label', () => {
  it('shows the place of the current read as a whole percent', () => {
    const positions = [
      position(A, 'phone', 10, { charPos: 10, progress: 0.25, readThroughId: null }),
      position(A, 'boox', 20, { charPos: 50, progress: 0.426, readThroughId: null })
    ];
    expect(bookProgressLabel(A, undefined, positions, 100)).toBe('42%');
  });

  it('takes the furthest place of any device, not the newest (WP8b)', () => {
    const positions = [
      position(A, 'boox', 10, { charPos: 600, progress: 0.6, readThroughId: null }),
      // Saved later on a device that was behind (e.g. opened at an old place).
      position(A, 'phone', 20, { charPos: 300, progress: 0.3, readThroughId: null })
    ];
    expect(bookProgressLabel(A, undefined, positions, 1000)).toBe('60%');
    expect(furthestPosition(A, undefined, positions, 1000)?.record.deviceId).toBe('boox');
  });

  it('prefers the newest record on a tie and compares copies by fraction', () => {
    const positions = [
      position(A, 'a', 10, { charPos: 500, progress: 0.5, readThroughId: null }),
      position(A, 'b', 30, { charPos: 500, progress: 0.5, readThroughId: null }),
      // Another copy with more characters: a higher charPos but a lower fraction.
      position(A, 'c', 40, { charPos: 520, progress: 0.4, readThroughId: null })
    ];
    expect(furthestPosition(A, undefined, positions, 1000)?.record.deviceId).toBe('b');
    expect(bookProgressLabel(A, undefined, positions, 1000)).toBe('50%');
  });

  it('starts again from the new read after Start over', () => {
    const state: BookState = {
      ...bookStateFrom(A, []),
      status: 'unread',
      readThroughs: [
        {
          id: `${A}:2`,
          number: 2,
          origin: 'start-over',
          startedOn: '2026-11-09',
          finished: false,
          finishedOn: null,
          manual: false,
          charCount: null
        }
      ]
    };
    const old = position(A, 'boox', 5, { charPos: 900, progress: 0.9, readThroughId: null });
    expect(bookProgressLabel(A, state, [old], 1000)).toBeNull();
    const start = position(A, 'phone', 9, { charPos: 0, progress: 0, readThroughId: `${A}:2` });
    expect(bookProgressLabel(A, state, [old, start], 1000)).toBe('0%');
    const later = position(A, 'boox', 12, {
      charPos: 150,
      progress: 0.15,
      readThroughId: `${A}:2`
    });
    expect(bookProgressLabel(A, state, [later, start], 1000)).toBe('15%');
  });

  it('falls back to the character position and the catalog count', () => {
    const positions = [position(A, 'p', 1, { charPos: 300, progress: null, readThroughId: null })];
    expect(bookProgressLabel(A, undefined, positions, 1000)).toBe('30%');
    expect(bookProgressLabel(A, undefined, positions, null)).toBeNull();
  });

  it('says Finished for completed books and ignores older reads and deleted records', () => {
    const completed: BookState = { ...bookStateFrom(A, []), status: 'completed' };
    expect(bookProgressLabel(A, completed, [], 10)).toBe('Finished');
    const startedOver: BookState = {
      ...bookStateFrom(A, []),
      readThroughs: [
        {
          id: `${A}:2`,
          number: 2,
          origin: 'start-over',
          startedOn: '2026-11-09',
          finished: false,
          finishedOn: null,
          manual: false,
          charCount: null
        }
      ]
    };
    const positions = [
      position(A, 'old', 5, { charPos: 90, progress: 0.9, readThroughId: null }),
      {
        ...position(A, 'gone', 9, { charPos: 1, progress: 0.5, readThroughId: `${A}:2` }),
        deletedAt: 9
      }
    ];
    expect(bookProgressLabel(A, startedOver, positions, 100)).toBeNull();
    expect(bookProgressLabel(B, undefined, positions, 100)).toBeNull();
  });

  it('groups positions by book and counts read volumes', () => {
    const map = positionsByBook([
      position(A, 'x', 1, {}),
      position(B, 'x', 1, {}),
      position(A, 'y', 1, {})
    ]);
    expect(map.get(A)).toHaveLength(2);
    const states = new Map([[A, { ...bookStateFrom(A, []), status: 'completed' as const }]]);
    expect(seriesReadCount([A, B], states)).toBe(1);
  });
});

let run = 0;
async function deps(): Promise<BookStateDeps & { engine: SyncEngine; warnings: string[] }> {
  run += 1;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(`library-view-${run}`),
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

describe('bulk book state', () => {
  it('sets status, favorite and blur for many books', async () => {
    const d = await deps();
    expect(await setBooksStatus([A, B], 'dropped', d)).toEqual([]);
    expect(await setBooksFavorite([A, B], true, d)).toEqual([]);
    expect(await setBooksBlur([B], 'always', d)).toEqual([]);
    const states = await getAllBookStates(d);
    expect(states.get(A)).toMatchObject({ status: 'dropped', favorite: true, blur: 'inherit' });
    expect(states.get(B)).toMatchObject({ status: 'dropped', favorite: true, blur: 'always' });
  });

  it('returns the books that could not be saved and keeps the others', async () => {
    const d = await deps();
    const put = d.engine.put.bind(d.engine);
    d.engine.put = async (kind, id, data, options) =>
      id === B ? false : put(kind, id, data, options);
    expect(await setBooksFavorite([A, B], true, d)).toEqual([B]);
    expect((await getAllBookStates(d)).get(A)?.favorite).toBe(true);
    expect(d.warnings).toHaveLength(1);
  });
});

describe('tag blur rules', () => {
  it('switches rules on and off as synced records', async () => {
    const d = await deps();
    await setTagBlur(d.engine, 'BL', true);
    await setTagBlur(d.engine, 'ホラー', true);
    await setTagBlur(d.engine, 'BL', false);
    expect([...(await getTagBlurRules(d.engine))]).toEqual(['ホラー']);
    const records = await d.engine.getAll(TAG_BLUR_KIND);
    expect(records.find((r) => r.id === 'BL')?.deletedAt).not.toBeNull();
    expect((await d.engine.status()).pending).toBe(2);
  });
});

describe('LibraryApi browse', () => {
  it('builds group and group-book queries', async () => {
    const urls: string[] = [];
    const api = new LibraryApi('http://s', 't', 0, async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ books: [], groups: [], nextCursor: null }));
    });
    await api.groups({ by: 'tag', q: 'status:reading', library: 'l', cursor: 'c' });
    await api.books({ group: { by: 'series', name: '薬屋のひとりごと' } });
    await api.books({ group: { by: 'series', name: null }, q: 'x' });
    expect(urls).toEqual([
      'http://s/api/v1/groups?by=tag&q=status%3Areading&library=l&cursor=c',
      `http://s/api/v1/books?by=series&group=${encodeURIComponent('薬屋のひとりごと')}`,
      'http://s/api/v1/books?q=x&by=series&none=1'
    ]);
  });

  it('passes the span of a search error', async () => {
    const api = new LibraryApi(
      'http://s',
      't',
      0,
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'invalid_query', message: 'bad', start: 3, end: 7 } }),
          { status: 400 }
        )
    );
    const error = await api.books({ q: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(LibraryApiError);
    expect(error).toMatchObject({ code: 'invalid_query', span: { start: 3, end: 7 } });
  });
});
