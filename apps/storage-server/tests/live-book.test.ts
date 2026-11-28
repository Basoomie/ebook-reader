/**
 * The live lookup of a Calibre book (calibre/live-book.ts, 2026-11-28): by the Calibre id first,
 * the UUID search only when the id doesn't name the book, and read on a thread of its own.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupLiveBook, lookupLiveBookSync } from '../src/calibre/live-book';
import { readLiveBook } from '../src/calibre/live-book-read';
import { currentCalibreEpub, liveTitleSort } from '../src/calibre/live-lookup';

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-live-book-'));
  file = path.join(dir, 'metadata.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, sort TEXT, path TEXT NOT NULL DEFAULT '',
      uuid TEXT, has_cover BOOL DEFAULT 0);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL,
      uncompressed_size INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL);
    CREATE INDEX data_idx ON data (book);
  `);
  const book = db.prepare(
    'INSERT INTO books (id, title, sort, path, uuid, has_cover) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const data = db.prepare('INSERT INTO data (book, format, name) VALUES (?, ?, ?)');
  book.run(1, 'A', 'A sort', 'Author/A (1)', 'uuid-a', 1);
  data.run(1, 'EPUB', 'A - Author');
  data.run(1, 'pdf', 'A - Author');
  book.run(2, 'B', null, 'Author/B (2)', 'uuid-b', 0);
  db.close();
  fs.mkdirSync(path.join(dir, 'Author', 'A (1)'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Author', 'A (1)', 'A - Author.epub'), 'x');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readLiveBook', () => {
  it('finds the book by its id and lists its formats', () => {
    const db = new Database(file, { readonly: true });
    const b = readLiveBook(db, { uuid: 'uuid-a', calibreId: 1 });
    db.close();
    expect(b).toMatchObject({
      id: 1,
      uuid: 'uuid-a',
      path: 'Author/A (1)',
      hasCover: true,
      sort: 'A sort',
    });
    expect(b?.formats.get('EPUB')).toBe('Author/A (1)/A - Author.epub');
    expect(b?.formats.get('PDF')).toBe('Author/A (1)/A - Author.pdf');
  });

  it('searches by UUID when the id names another book, or none', () => {
    const db = new Database(file, { readonly: true });
    expect(readLiveBook(db, { uuid: 'uuid-a', calibreId: 2 })?.id).toBe(1);
    expect(readLiveBook(db, { uuid: 'uuid-b', calibreId: 999 })?.id).toBe(2);
    expect(readLiveBook(db, { uuid: 'uuid-b' })).toMatchObject({
      id: 2,
      sort: '',
      hasCover: false,
    });
    expect(readLiveBook(db, { uuid: 'gone', calibreId: 1 })).toBeNull();
    db.close();
  });

  it('reads the id by the primary key, not the whole table', () => {
    const db = new Database(file, { readonly: true });
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id, uuid, path, has_cover, sort FROM books WHERE id = ?')
      .all(1) as { detail: string }[];
    db.close();
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/INTEGER PRIMARY KEY/);
  });
});

describe('lookupLiveBook (its own thread)', () => {
  it('answers like the synchronous lookup', async () => {
    const sync = lookupLiveBookSync(file, { uuid: 'uuid-a', calibreId: 1 });
    const threaded = await lookupLiveBook(file, { uuid: 'uuid-a', calibreId: 1 });
    expect(threaded).toEqual(sync);
    expect(await lookupLiveBook(file, { uuid: 'uuid-b', calibreId: 7 })).toMatchObject({ id: 2 });
    expect(await lookupLiveBook(file, { uuid: 'nobody' })).toBeNull();
  }, 30_000);

  it('rejects when the database can not be read, and keeps working after', async () => {
    await expect(lookupLiveBook(path.join(dir, 'missing.db'), { uuid: 'x' })).rejects.toThrow();
    expect(await lookupLiveBook(file, { uuid: 'uuid-a' })).toMatchObject({ id: 1 });
  }, 30_000);

  it('serves currentCalibreEpub and liveTitleSort', async () => {
    expect(await currentCalibreEpub(dir, 'uuid-a', 1)).toBe('Author/A (1)/A - Author.epub');
    expect(await currentCalibreEpub(dir, 'uuid-a', 2)).toBe('Author/A (1)/A - Author.epub');
    // No EPUB file on disk for B (and no EPUB format): null.
    expect(await currentCalibreEpub(dir, 'uuid-b', 2)).toBeNull();
    expect(liveTitleSort(dir, 'uuid-a', 1)).toBe('A sort');
    expect(liveTitleSort(dir, 'uuid-b')).toBe('');
    expect(liveTitleSort(dir, 'nobody', 1)).toBeNull();
  }, 30_000);
});
