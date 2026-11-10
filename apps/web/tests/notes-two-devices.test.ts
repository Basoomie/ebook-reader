/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP11a: highlights and notes between devices, against the real storage server
 * (tests/helpers/sync-harness.ts):
 * - a highlight made on A shows on B with its note;
 * - a color change on A and a note edit on B, both offline, both survive;
 * - A removing a highlight while B edits its note offline keeps the note (as a book note
 *   with its quote);
 * - free book notes sync and can be removed;
 * - highlights belong to the book: still there after Start over;
 * - none of this writes stat-day or position records.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TextAnchor } from '$lib/notes/anchor';
import {
  addHighlight,
  getBookNotes,
  removeHighlight,
  removeNote,
  saveNote,
  setHighlightColor,
  type NotesDeps
} from '$lib/notes/notes-service';
import { startBookOver, type BookStateDeps } from '$lib/sync/book-state-service';
import { addBookmark, getBookmarks, removeBookmark, renameBookmark } from '$lib/notes/bookmarks';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

function deps(device: Device): NotesDeps {
  return { getEngine: async () => device.engine, warn: () => {} };
}

function stateDeps(device: Device): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => '2026-11-10', warn: () => {} };
}

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

const anchor = (start: number, text: string): TextAnchor => ({
  start,
  end: start + text.length,
  text,
  before: '一章',
  after: '。名前はまだ無い'
});

describe('highlights and notes between devices (real server)', () => {
  const server = new TestServer();
  let book: string;
  let a: Device;
  let b: Device;

  beforeAll(async () => {
    const seeded = seedServer(server, 2, { catalog: true });
    book = seeded.bookId;
    await server.start();
    a = new Device('A', seeded.tokens[0], server);
    b = new Device('B', seeded.tokens[1], server);
    await a.open();
    await b.open();
    await syncAll(a, b);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('a highlight and its note made on A show on B', async () => {
    const h = await addHighlight(book, anchor(2, '吾輩は猫である'), 2, '一', deps(a));
    await saveNote({ bookId: book, highlight: h }, 'いい書き出し', deps(a));
    await syncAll(a, b);
    const onB = await getBookNotes(book, deps(b));
    expect(onB.highlights).toHaveLength(1);
    expect(onB.highlights[0]).toMatchObject({
      id: h.id,
      text: '吾輩は猫である',
      start: 2,
      color: 2,
      chapter: '一',
      note: { body: 'いい書き出し' }
    });
    expect((await b.engine.status()).rejected).toBe(0);
  });

  it('an offline color change on A and note edit on B both survive', async () => {
    const [h] = (await getBookNotes(book, deps(a))).highlights;
    a.online = false;
    b.online = false;
    await setHighlightColor(h.id, 5, deps(a));
    await saveNote({ bookId: book, highlight: h, noteId: h.note?.id }, '書き直したメモ', deps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);

    for (const device of [a, b]) {
      const [item] = (await getBookNotes(book, deps(device))).highlights;
      expect(item.color).toBe(5);
      expect(item.note?.body).toBe('書き直したメモ');
    }
  });

  it('a highlight removed on A while B edits its note keeps the note as a book note', async () => {
    const h = await addHighlight(book, anchor(40, '名前はまだ無い'), 1, null, deps(a));
    await saveNote({ bookId: book, highlight: h }, '最初', deps(a));
    await syncAll(a, b);

    a.online = false;
    b.online = false;
    await removeHighlight(h.id, deps(a));
    // B's edit must be later than A's removal: within the same millisecond lww breaks the
    // tie by device id, and A's removal of the note may win (the intended rule).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [onB] = (await getBookNotes(book, deps(b))).highlights.filter((x) => x.id === h.id);
    await saveNote({ bookId: book, highlight: onB, noteId: onB.note?.id }, '残したいメモ', deps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);

    for (const device of [a, b]) {
      const notes = await getBookNotes(book, deps(device));
      expect(notes.highlights.map((x) => x.id)).not.toContain(h.id);
      expect(notes.notes.map((n) => [n.body, n.quote])).toContainEqual([
        '残したいメモ',
        '名前はまだ無い'
      ]);
    }
  });

  it('free book notes sync and can be removed', async () => {
    const id = (await saveNote({ bookId: book }, '全体の感想', deps(b)))!;
    await syncAll(a, b);
    expect((await getBookNotes(book, deps(a))).notes.map((n) => n.body)).toContain('全体の感想');
    await removeNote(id, deps(a));
    await syncAll(a, b);
    expect((await getBookNotes(book, deps(b))).notes.map((n) => n.body)).not.toContain(
      '全体の感想'
    );
  });

  it('highlights belong to the book: still there after Start over', async () => {
    const before = (await getBookNotes(book, deps(b))).highlights.map((h) => h.id);
    await startBookOver(book, stateDeps(a));
    await syncAll(a, b);
    expect((await getBookNotes(book, deps(b))).highlights.map((h) => h.id)).toEqual(before);
  });

  it('WP11b: bookmarks sync; an offline rename and a removal elsewhere resolve by time', async () => {
    const place = { pos: 120, text: '吾輩は猫である', before: '一章', after: '名前' };
    const first = await addBookmark(book, place, '猫の場所', '一', deps(a));
    const second = await addBookmark(book, { ...place, pos: 300 }, '二つ目', '一', deps(a));
    await syncAll(a, b);
    expect((await getBookmarks(book, deps(b))).map((x) => [x.name, x.pos])).toEqual([
      ['猫の場所', 120],
      ['二つ目', 300]
    ]);

    a.online = false;
    b.online = false;
    await removeBookmark(second.id, deps(a));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await renameBookmark(first.id, '猫の名前の場所', deps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);

    for (const device of [a, b]) {
      expect((await getBookmarks(book, deps(device))).map((x) => x.name)).toEqual([
        '猫の名前の場所'
      ]);
    }
  });

  it('wrote no stat-day or position records and nothing was refused', async () => {
    for (const device of [a, b]) {
      expect(await device.engine.getAll('stat-day')).toEqual([]);
      expect(await device.engine.getAll('position')).toEqual([]);
      expect((await device.engine.status()).rejected).toBe(0);
    }
  });
});
