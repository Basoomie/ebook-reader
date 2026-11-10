/**
 * WP8a: book-state kinds (book-status, book-favorite, book-blur, read-through).
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseReadThroughId } from '../src/sync/kinds';
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

function setup() {
  const t = makeTestApp();
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  async function device(label: string) {
    const token = t.newUserToken(label);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(t.app)
      .post('/api/v1/devices/register')
      .set(auth)
      .send({ deviceId: randomUUID() });
    expect(res.status).toBe(200);
    return { auth, id: res.body.device.id as string };
  }
  const push = async (auth: object, changes: unknown[]) =>
    (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body.results as any[];
  const pull = async (auth: object) =>
    (await request(t.app).get('/api/v1/sync').set(auth)).body.records as any[];
  return { ...t, db, device, push, pull };
}

const readThrough = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  origin: 'start-over',
  startedOn: '2026-11-09',
  finished: false,
  finishedOn: null,
  manual: false,
  charCount: null,
  ...extra,
});

describe('book-status, book-favorite, book-blur', () => {
  it('validates ids and payloads', async () => {
    const t = setup();
    const a = await t.device('A');
    const book = insertBook(t.db);
    const at = Date.now();
    const results = await t.push(a.auth, [
      { kind: 'book-status', id: book, updatedAt: at, data: { status: 'reading', auto: true } },
      { kind: 'book-status', id: book, updatedAt: at, data: { status: 'planned', auto: false } },
      {
        kind: 'book-status',
        id: randomUUID(),
        updatedAt: at,
        data: { status: 'reading', auto: false },
      },
      { kind: 'book-status', id: 'nope', updatedAt: at, data: { status: 'reading', auto: false } },
      { kind: 'book-status', id: book, updatedAt: at, deletedAt: at },
      { kind: 'book-favorite', id: book, updatedAt: at, data: { favorite: true } },
      { kind: 'book-favorite', id: book, updatedAt: at, data: { favorite: 'yes' } },
      { kind: 'book-blur', id: book, updatedAt: at, data: { blur: 'always' } },
      { kind: 'book-blur', id: book, updatedAt: at, data: { blur: 'sometimes' } },
    ]);
    expect(results.map((r) => r.error?.code ?? r.status)).toEqual([
      'applied',
      'invalid_data',
      'unknown_book',
      'invalid_id',
      'not_deletable',
      'applied',
      'invalid_data',
      'applied',
      'invalid_data',
    ]);
    const records = await t.pull(a.auth);
    expect(records.find((r) => r.kind === 'book-status')).toMatchObject({
      bookId: book,
      data: { status: 'reading', auto: true },
    });
    expect(records.find((r) => r.kind === 'book-blur')).toMatchObject({
      bookId: book,
      data: { blur: 'always' },
    });
  });

  it('keeps fields edited on different devices apart (separate records, lww each)', async () => {
    const t = setup();
    const a = await t.device('A');
    const b = await t.device('B');
    const book = insertBook(t.db);
    const at = Date.now();
    // A sets the favorite; B (offline, older clock) later pushes an automatic status.
    await t.push(a.auth, [
      { kind: 'book-favorite', id: book, updatedAt: at + 10, data: { favorite: true } },
    ]);
    const res = await t.push(b.auth, [
      { kind: 'book-status', id: book, updatedAt: at, data: { status: 'reading', auto: true } },
    ]);
    expect(res[0].status).toBe('applied');
    const records = await t.pull(a.auth);
    expect(records.find((r) => r.kind === 'book-favorite').data).toEqual({ favorite: true });
    expect(records.find((r) => r.kind === 'book-status').data).toEqual({
      status: 'reading',
      auto: true,
    });
    // Within one record the newer write wins.
    const stale = await t.push(a.auth, [
      {
        kind: 'book-status',
        id: book,
        updatedAt: at - 5,
        data: { status: 'dropped', auto: false },
      },
    ]);
    expect(stale[0].status).toBe('stale');
  });
});

describe('read-through', () => {
  it('parses ids', () => {
    const book = randomUUID();
    expect(parseReadThroughId(`${book}:1`)).toEqual({ bookId: book, number: 1 });
    expect(parseReadThroughId(`${book}:9999`)).toEqual({ bookId: book, number: 9999 });
    expect(parseReadThroughId(`${book}:0`)).toBeNull();
    expect(parseReadThroughId(`${book}:01`)).toBeNull();
    expect(parseReadThroughId(`${book}:10000`)).toBeNull();
    expect(parseReadThroughId(book)).toBeNull();
  });

  it('validates payloads and allows deletion', async () => {
    const t = setup();
    const a = await t.device('A');
    const book = insertBook(t.db);
    const at = Date.now();
    const id = `${book}:2`;
    const results = await t.push(a.auth, [
      { kind: 'read-through', id, updatedAt: at, data: readThrough(3) },
      { kind: 'read-through', id, updatedAt: at, data: readThrough(2, { origin: 'other' }) },
      { kind: 'read-through', id, updatedAt: at, data: readThrough(2, { startedOn: '9.11.2026' }) },
      {
        kind: 'read-through',
        id,
        updatedAt: at,
        data: readThrough(2, { finishedOn: '2026-11-09' }),
      },
      { kind: 'read-through', id, updatedAt: at, data: readThrough(2, { charCount: -1 }) },
      { kind: 'read-through', id, updatedAt: at, data: readThrough(2, { manual: 1 }) },
      { kind: 'read-through', id: `${randomUUID()}:1`, updatedAt: at, data: readThrough(1) },
      { kind: 'read-through', id: `${book}:x`, updatedAt: at, data: readThrough(1) },
      {
        kind: 'read-through',
        id,
        updatedAt: at,
        data: readThrough(2, {
          origin: 'completion',
          startedOn: null,
          finished: true,
          finishedOn: null,
          manual: true,
          charCount: 120000,
        }),
      },
      { kind: 'read-through', id, updatedAt: at + 1, deletedAt: at + 1 },
    ]);
    expect(results.map((r) => r.error?.code ?? r.status)).toEqual([
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'unknown_book',
      'invalid_id',
      'applied',
      'applied',
    ]);
    const rec = (await t.pull(a.auth)).find((r) => r.kind === 'read-through');
    expect(rec).toMatchObject({ id, bookId: book, deletedAt: at + 1 });
  });

  it('merges the same Start over made on two devices offline', async () => {
    const t = setup();
    const a = await t.device('A');
    const b = await t.device('B');
    const book = insertBook(t.db);
    const at = Date.now();
    const id = `${book}:2`;
    expect(
      (await t.push(a.auth, [{ kind: 'read-through', id, updatedAt: at, data: readThrough(2) }]))[0]
        .status,
    ).toBe('applied');
    expect(
      (
        await t.push(b.auth, [
          { kind: 'read-through', id, updatedAt: at - 1, data: readThrough(2) },
        ])
      )[0].status,
    ).toBe('stale');
    const records = (await t.pull(a.auth)).filter((r) => r.kind === 'read-through');
    expect(records).toHaveLength(1);
  });
});
