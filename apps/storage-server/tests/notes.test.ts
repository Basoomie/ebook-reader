/**
 * WP11a: highlight and note kinds.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseBookItemId, parseNoteId } from '../src/sync/kinds';
import { makeTestApp } from './helpers/test-app';

function insertBook(db: Database.Database): string {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'lib', 'Lib', ?, ?)`,
  ).run(now, now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', 'Book', ?, ?, ?)`,
  ).run(id, now, now, now);
  return id;
}

async function setup() {
  const t = makeTestApp();
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  const token = t.newUserToken('A');
  const auth = { Authorization: `Bearer ${token}` };
  const reg = await request(t.app)
    .post('/api/v1/devices/register')
    .set(auth)
    .send({ deviceId: randomUUID() });
  expect(reg.status).toBe(200);
  const push = async (changes: unknown[]) =>
    (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body.results as any[];
  const pull = async () =>
    (await request(t.app).get('/api/v1/sync').set(auth)).body.records as any[];
  return { db, push, pull };
}

const highlight = (extra: Record<string, unknown> = {}) => ({
  start: 120,
  end: 128,
  text: '吾輩は猫である',
  before: '一章',
  after: '。名前はまだ無い',
  color: 2,
  chapter: '一',
  createdAt: 1_700_000_000_000,
  ...extra,
});

const codes = (results: any[]) => results.map((r) => r.error?.code ?? r.status);

describe('ids', () => {
  it('parses book item and note ids', () => {
    const book = randomUUID();
    const item = randomUUID();
    expect(parseBookItemId(`${book}:${item}`)).toEqual({ bookId: book, itemId: item });
    expect(parseBookItemId(item)).toBeNull();
    expect(parseBookItemId(`${book}:h:${item}`)).toBeNull();
    expect(parseNoteId(`${book}:${item}`)).toEqual({
      bookId: book,
      highlightId: null,
      itemId: item,
    });
    expect(parseNoteId(`${book}:h:${item}`)).toEqual({
      bookId: book,
      highlightId: `${book}:${item}`,
      itemId: item,
    });
    expect(parseNoteId(`${book}:x:${item}`)).toBeNull();
  });
});

describe('highlight kind', () => {
  it('validates ids and payloads', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const at = Date.now();
    const id = () => `${book}:${randomUUID()}`;
    const results = await t.push([
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight() },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ chapter: undefined }) },
      { kind: 'highlight', id: randomUUID(), updatedAt: at, data: highlight() },
      {
        kind: 'highlight',
        id: `${randomUUID()}:${randomUUID()}`,
        updatedAt: at,
        data: highlight(),
      },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ color: 6 }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ color: '2' }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ end: 100 }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ start: -1 }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ start: 1.5 }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ text: '  ' }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ before: 'あ'.repeat(33) }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ after: 'あ'.repeat(32) }) },
      { kind: 'highlight', id: id(), updatedAt: at, data: highlight({ createdAt: 'now' }) },
      {
        kind: 'highlight',
        id: id(),
        updatedAt: at,
        data: highlight({ text: '𠮷'.repeat(10_000) }),
      },
      {
        kind: 'highlight',
        id: id(),
        updatedAt: at,
        data: highlight({ text: 'あ'.repeat(10_001) }),
      },
    ]);
    expect(codes(results)).toEqual([
      'applied',
      'applied',
      'invalid_id',
      'unknown_book',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'applied',
      'invalid_data',
      'applied',
      'invalid_data',
    ]);
  });

  it('keeps the book on deletion markers and revives on a newer edit', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const id = `${book}:${randomUUID()}`;
    expect(
      codes(await t.push([{ kind: 'highlight', id, updatedAt: 1000, data: highlight() }])),
    ).toEqual(['applied']);
    expect(
      codes(await t.push([{ kind: 'highlight', id, updatedAt: 2000, deletedAt: 2000 }])),
    ).toEqual(['applied']);
    const deleted = (await t.pull()).find((r) => r.id === id);
    expect(deleted.bookId).toBe(book);
    expect(deleted.deletedAt).toBe(2000);
    const stored = t.db
      .prepare(`SELECT book_id FROM sync_records WHERE kind = 'highlight' AND id = ?`)
      .get(id) as { book_id: string };
    expect(stored.book_id).toBe(book);
    expect(
      codes(
        await t.push([{ kind: 'highlight', id, updatedAt: 3000, data: highlight({ color: 5 }) }]),
      ),
    ).toEqual(['applied']);
    const revived = (await t.pull()).find((r) => r.id === id);
    expect(revived.deletedAt).toBeNull();
    expect(revived.data.color).toBe(5);
    expect(revived.data.chapter).toBe('一');
  });
});

describe('note kind', () => {
  it('validates free and attached notes', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const hl = randomUUID();
    const at = Date.now();
    const note = (extra: Record<string, unknown> = {}) => ({
      body: 'メモ',
      highlightId: null,
      createdAt: at,
      ...extra,
    });
    const results = await t.push([
      { kind: 'note', id: `${book}:${randomUUID()}`, updatedAt: at, data: note() },
      {
        kind: 'note',
        id: `${book}:h:${hl}`,
        updatedAt: at,
        data: note({ highlightId: `${book}:${hl}`, quote: '吾輩は猫である' }),
      },
      { kind: 'note', id: `${book}:h:${hl}`, updatedAt: at + 1, data: note() },
      {
        kind: 'note',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: note({ highlightId: `${book}:${hl}` }),
      },
      { kind: 'note', id: `${book}:${randomUUID()}`, updatedAt: at, data: note({ body: ' ' }) },
      {
        kind: 'note',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: note({ body: 'あ'.repeat(20_001) }),
      },
      {
        kind: 'note',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: note({ quote: 'あ'.repeat(301) }),
      },
      { kind: 'note', id: `${randomUUID()}:${randomUUID()}`, updatedAt: at, data: note() },
      { kind: 'note', id: `${book}:x:${hl}`, updatedAt: at, data: note() },
    ]);
    expect(codes(results)).toEqual([
      'applied',
      'applied',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'unknown_book',
      'invalid_id',
    ]);
  });

  it('a note deletion keeps its book', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const id = `${book}:h:${randomUUID()}`;
    await t.push([
      {
        kind: 'note',
        id,
        updatedAt: 1000,
        data: { body: 'x', highlightId: `${book}:${id.split(':')[2]}`, createdAt: 1000 },
      },
    ]);
    expect(codes(await t.push([{ kind: 'note', id, updatedAt: 2000, deletedAt: 2000 }]))).toEqual([
      'applied',
    ]);
    const deleted = (await t.pull()).find((r) => r.id === id);
    expect(deleted.bookId).toBe(book);
  });
});

describe('bookmark kind (WP11b)', () => {
  const bookmark = (extra: Record<string, unknown> = {}) => ({
    pos: 1200,
    text: '吾輩は猫である。名前は',
    before: '一章',
    after: 'まだ無い',
    name: '  猫の名前  ',
    chapter: '一',
    createdAt: 1_700_000_000_000,
    ...extra,
  });

  it('validates ids and payloads, trims the name, keeps the book on deletion', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const at = Date.now();
    const id = `${book}:${randomUUID()}`;
    const results = await t.push([
      { kind: 'bookmark', id, updatedAt: at, data: bookmark() },
      {
        kind: 'bookmark',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: bookmark({ text: '' }),
      },
      { kind: 'bookmark', id: randomUUID(), updatedAt: at, data: bookmark() },
      { kind: 'bookmark', id: `${randomUUID()}:${randomUUID()}`, updatedAt: at, data: bookmark() },
      {
        kind: 'bookmark',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: bookmark({ name: ' ' }),
      },
      {
        kind: 'bookmark',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: bookmark({ name: 'あ'.repeat(201) }),
      },
      {
        kind: 'bookmark',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: bookmark({ pos: -3 }),
      },
      {
        kind: 'bookmark',
        id: `${book}:${randomUUID()}`,
        updatedAt: at,
        data: bookmark({ text: 'あ'.repeat(33) }),
      },
    ]);
    expect(codes(results)).toEqual([
      'applied',
      'applied',
      'invalid_id',
      'unknown_book',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
    ]);
    const stored = (await t.pull()).find((r) => r.id === id);
    expect(stored.data.name).toBe('猫の名前');
    expect(stored.bookId).toBe(book);
    expect(
      codes(await t.push([{ kind: 'bookmark', id, updatedAt: at + 10, deletedAt: at + 10 }])),
    ).toEqual(['applied']);
    expect((await t.pull()).find((r) => r.id === id).bookId).toBe(book);
  });
});
