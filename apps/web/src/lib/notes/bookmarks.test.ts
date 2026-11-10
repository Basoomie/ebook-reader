/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { buildBookTextIndex, parseBookHtml } from '$lib/components/book-reader/book-search';
import { ReturnMarker } from '$lib/components/book-reader/return-marker';
import { openSyncDb } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';
import {
  addBookmark,
  bookmarkPlaceAt,
  defaultBookmarkName,
  getBookmarks,
  placeBookmark,
  removeBookmark,
  renameBookmark
} from './bookmarks';
import type { NotesDeps } from './notes-service';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const HTML =
  '<p>一章</p><p>吾輩は猫である。名前はまだ無い。</p><p>どこで生れたかとんと見当がつかぬ。</p>';

beforeAll(() => {
  installNodeDom();
});

const index = (html: string) => buildBookTextIndex(parseBookHtml(html));

let run = 0;
async function deps(): Promise<NotesDeps & { engine: SyncEngine }> {
  run += 1;
  let n = 0;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(`bookmarks-${run}`),
    newId: () => DEVICE
  });
  return {
    engine,
    getEngine: async () => engine,
    warn: () => {},
    newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    now: () => 1_700_000_000_000 + n
  };
}

describe('bookmark places', () => {
  it('keeps the text at the position and its context', () => {
    // 一章 (2) + 吾輩は (3): position 5 is 猫.
    const place = bookmarkPlaceAt(index(HTML), 5);
    expect(place.pos).toBe(5);
    expect(place.text.startsWith('猫である。名前は')).toBe(true);
    expect(place.before.endsWith('吾輩は')).toBe(true);
  });

  it('starts at the next counted character, not the 。 that ends the previous paragraph', () => {
    const html = '<p>一章。</p><p>「次の段落」です。</p>';
    // 一章 (2): position 2 is shared by 。 and 「.
    const place = bookmarkPlaceAt(index(html), 2);
    expect(place.text.startsWith('「次の段落」')).toBe(true);
    expect(defaultBookmarkName(index(html), 2)).toBe('「次の段落」です。');
    expect(placeBookmark(index('<p>前書き。</p>' + html), place, 2000)).toBe(5);
  });

  it('names a bookmark after the first sentence of the page', () => {
    expect(defaultBookmarkName(index(HTML), 2)).toBe('吾輩は猫である。');
    expect(defaultBookmarkName(index('<p>' + 'あ'.repeat(80) + '</p>'), 0)).toBe(
      'あ'.repeat(40) + '…'
    );
  });

  it('is placed exactly, found again after a change, or unplaced', () => {
    const place = bookmarkPlaceAt(index(HTML), 5);
    expect(placeBookmark(index(HTML), place, 2000)).toBe(5);
    const changed = '<p>新しい序文がここにある。</p>' + HTML;
    // 新しい序文がここにある (11) more characters before it.
    expect(placeBookmark(index(changed), place, 2000)).toBe(16);
    expect(placeBookmark(index('<p>全く別の本です。</p>'), place, 2000)).toBeNull();
  });

  it('a bookmark without text (end of the book) stays at its position', () => {
    expect(placeBookmark(index(HTML), { pos: 999, text: '', before: '', after: '' }, 10)).toBe(
      index(HTML).total
    );
  });
});

describe('bookmark service', () => {
  it('adds in book order, renames, removes with undo', async () => {
    const d = await deps();
    const place = bookmarkPlaceAt(index(HTML), 5);
    const later = await addBookmark(BOOK, { ...place, pos: 9 }, '後', '一', d);
    const first = await addBookmark(BOOK, place, '  猫  ', null, d);
    expect(later.id.startsWith(`${BOOK}:`)).toBe(true);
    expect((await getBookmarks(BOOK, d)).map((b) => b.name)).toEqual(['猫', '後']);
    await renameBookmark(first.id, '猫の場所', d);
    expect((await getBookmarks(BOOK, d))[0]).toMatchObject({ name: '猫の場所', pos: 5 });
    const undo = await removeBookmark(first.id, d);
    expect((await getBookmarks(BOOK, d)).map((b) => b.name)).toEqual(['後']);
    await undo();
    expect((await getBookmarks(BOOK, d)).map((b) => b.name)).toEqual(['猫の場所', '後']);
  });

  it('refuses empty or too long names and writes no position records', async () => {
    const d = await deps();
    const place = bookmarkPlaceAt(index(HTML), 5);
    await expect(addBookmark(BOOK, place, '  ', null, d)).rejects.toThrow('needs a name');
    await expect(addBookmark(BOOK, place, 'あ'.repeat(201), null, d)).rejects.toThrow('at most');
    await addBookmark(BOOK, place, 'ok', null, d);
    expect(await d.engine.getAll('position')).toEqual([]);
  });
});

describe('ReturnMarker', () => {
  it('keeps the place of the first jump until you go back there or close it', () => {
    const marker = new ReturnMarker();
    expect(marker.position).toBeUndefined();
    marker.noteJump(1200);
    marker.noteJump(5000);
    expect(marker.position).toBe(1200);
    marker.noteArrived(5000);
    expect(marker.position).toBe(1200);
    marker.noteArrived(1200);
    expect(marker.position).toBeUndefined();
    marker.noteJump(300);
    marker.clear();
    expect(marker.position).toBeUndefined();
    marker.noteJump(NaN);
    expect(marker.position).toBeUndefined();
  });
});
