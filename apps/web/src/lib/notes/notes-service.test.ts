/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openSyncDb, type LocalRecord } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';
import type { TextAnchor } from './anchor';
import { noteIdForHighlight, notesByBook, overlapping, quoteOf } from './highlights';
import {
  addHighlight,
  getAllNotes,
  getBookNotes,
  getUnplacedHighlights,
  onNotesChanged,
  removeHighlight,
  removeNote,
  saveNote,
  setHighlightColor,
  setUnplacedHighlights,
  type NotesDeps
} from './notes-service';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '11111111-1111-4111-8111-111111111111';

let run = 0;
async function deps(): Promise<NotesDeps & { engine: SyncEngine; warnings: string[] }> {
  run += 1;
  let n = 0;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(`notes-service-${run}`),
    newId: () => DEVICE
  });
  const warnings: string[] = [];
  return {
    engine,
    getEngine: async () => engine,
    warn: (m) => warnings.push(m),
    newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    now: () => 1_700_000_000_000 + n,
    warnings
  };
}

const anchor = (start: number, text: string): TextAnchor => ({
  start,
  end: start + text.length,
  text,
  before: '前',
  after: '後'
});

describe('notes service', () => {
  it('adds highlights in book order with their chapter', async () => {
    const d = await deps();
    const second = await addHighlight(BOOK, anchor(50, '猫である'), 3, '第一章', d);
    const first = await addHighlight(BOOK, anchor(10, '吾輩は'), 1, '  ', d);
    expect(second.id).toMatch(new RegExp(`^${BOOK}:`));
    const notes = await getBookNotes(BOOK, d);
    expect(notes.highlights.map((h) => [h.text, h.color, h.chapter])).toEqual([
      ['吾輩は', 1, null],
      ['猫である', 3, '第一章']
    ]);
    expect(notes.highlights[0].id).toBe(first.id);
    const outbox = await d.engine.status();
    expect(outbox.pending).toBe(2);
  });

  it('changes only the color', async () => {
    const d = await deps();
    const h = await addHighlight(BOOK, anchor(10, '吾輩は'), 1, null, d);
    await setHighlightColor(h.id, 4, d);
    const [after] = (await getBookNotes(BOOK, d)).highlights;
    expect(after).toMatchObject({ color: 4, start: 10, text: '吾輩は', createdAt: h.createdAt });
  });

  it('keeps one note per highlight, edits it, and removes it with an empty text', async () => {
    const d = await deps();
    const h = await addHighlight(BOOK, anchor(10, '吾輩は猫である'), 2, null, d);
    const id = await saveNote({ bookId: BOOK, highlight: h }, 'メモ', d);
    expect(id).toBe(noteIdForHighlight(h.id));
    expect(await saveNote({ bookId: BOOK, highlight: h }, 'メモ2', d)).toBe(id);
    let [item] = (await getBookNotes(BOOK, d)).highlights;
    expect(item.note).toMatchObject({ body: 'メモ2', highlightId: h.id, quote: '吾輩は猫である' });
    expect(await saveNote({ bookId: BOOK, highlight: h }, '  ', d)).toBeNull();
    [item] = (await getBookNotes(BOOK, d)).highlights;
    expect(item.note).toBeUndefined();
  });

  it('saves free notes about a book', async () => {
    const d = await deps();
    const id = await saveNote({ bookId: BOOK }, '全体の感想', d);
    await saveNote({ bookId: BOOK, noteId: id! }, '全体の感想、追記', d);
    const notes = await getBookNotes(BOOK, d);
    expect(notes.notes.map((n) => [n.body, n.highlightId])).toEqual([['全体の感想、追記', null]]);
  });

  it('removes a highlight with its note, and undo puts both back', async () => {
    const d = await deps();
    const h = await addHighlight(BOOK, anchor(10, '吾輩は'), 2, null, d);
    await saveNote({ bookId: BOOK, highlight: h }, 'メモ', d);
    const undo = await removeHighlight(h.id, d);
    expect(await getBookNotes(BOOK, d)).toEqual({ highlights: [], notes: [] });
    await undo();
    const [back] = (await getBookNotes(BOOK, d)).highlights;
    expect(back).toMatchObject({ id: h.id, color: 2, note: { body: 'メモ' } });
  });

  it('removes a note with undo', async () => {
    const d = await deps();
    const id = (await saveNote({ bookId: BOOK }, 'x', d))!;
    const undo = await removeNote(id, d);
    expect((await getBookNotes(BOOK, d)).notes).toEqual([]);
    await undo();
    expect((await getBookNotes(BOOK, d)).notes.map((n) => n.body)).toEqual(['x']);
  });

  it('refuses a change to a removed highlight and too long notes', async () => {
    const d = await deps();
    const h = await addHighlight(BOOK, anchor(10, '吾輩は'), 2, null, d);
    await removeHighlight(h.id, d);
    await expect(setHighlightColor(h.id, 3, d)).rejects.toThrow('removed');
    await expect(saveNote({ bookId: BOOK }, 'あ'.repeat(20_001), d)).rejects.toThrow('at most');
  });

  it('lists every book and tells listeners which book changed', async () => {
    const d = await deps();
    const seen: string[][] = [];
    const off = await onNotesChanged((books) => seen.push([...books]), d);
    await addHighlight(BOOK, anchor(1, 'あ'), 1, null, d);
    await saveNote({ bookId: OTHER }, 'メモ', d);
    off();
    await saveNote({ bookId: OTHER }, 'メモ2', d);
    expect(seen).toEqual([[BOOK], [OTHER]]);
    const all = await getAllNotes(d);
    expect([...all.keys()].sort()).toEqual([BOOK, OTHER]);
  });

  it('keeps unplaced highlights per book on this device only', async () => {
    const d = await deps();
    await setUnplacedHighlights(BOOK, [`${BOOK}:1`, `${BOOK}:2`], d);
    await setUnplacedHighlights(OTHER, [`${OTHER}:1`], d);
    await setUnplacedHighlights(BOOK, [`${BOOK}:2`], d);
    expect([...(await getUnplacedHighlights(d))].sort()).toEqual([`${BOOK}:2`, `${OTHER}:1`]);
    expect((await d.engine.status()).pending).toBe(0);
  });
});

describe('notesByBook', () => {
  const rec = (kind: string, id: string, data: object | null, deletedAt: number | null = null) =>
    ({
      kind,
      id,
      bookId: id.split(':')[0],
      deviceId: DEVICE,
      updatedAt: 5,
      deletedAt,
      rev: null,
      data
    }) as LocalRecord;
  const hl = (id: string, start: number) =>
    rec('highlight', `${BOOK}:${id}`, {
      start,
      end: start + 2,
      text: 'あい',
      before: '',
      after: '',
      color: 2,
      chapter: null,
      createdAt: 1
    });

  it('shows a note whose highlight is gone as a book note with its quote', () => {
    const notes = notesByBook([
      hl('h1', 5),
      rec('highlight', `${BOOK}:h2`, {}, 9),
      rec('note', `${BOOK}:h:h1`, { body: 'a', highlightId: `${BOOK}:h1`, createdAt: 1 }),
      rec('note', `${BOOK}:h:h2`, {
        body: 'b',
        highlightId: `${BOOK}:h2`,
        quote: '消えた',
        createdAt: 2
      }),
      rec('note', `${BOOK}:x`, null, 9)
    ]).get(BOOK)!;
    expect(notes.highlights.map((h) => [h.id, h.note?.body])).toEqual([[`${BOOK}:h1`, 'a']]);
    expect(notes.notes.map((n) => [n.body, n.quote])).toEqual([['b', '消えた']]);
  });

  it('orders highlights by place and finds overlaps', () => {
    const { highlights } = notesByBook([hl('b', 30), hl('a', 10), hl('c', 31)]).get(BOOK)!;
    expect(highlights.map((h) => h.start)).toEqual([10, 30, 31]);
    expect(overlapping(highlights, 11, 12).map((h) => h.start)).toEqual([10]);
    expect(overlapping(highlights, 12, 30)).toEqual([]);
  });

  it('cuts long quotes', () => {
    expect(Array.from(quoteOf('あ'.repeat(400))).length).toBe(300);
    expect(quoteOf('一\n二')).toBe('一 二');
  });
});
