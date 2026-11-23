/**
 * Calibre metadata on the book page: the ingest reads Calibre's #illustrator column (found by
 * its label, several names in Calibre's order) and its identifiers into the catalog (ttsu.db
 * migration 30), the API serves them (illustrators on every summary, identifiers on the
 * detail), and the search has an illustrator: field while plain text matches illustrator
 * names like author names. Uploaded books have neither.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { listUsers } from '../src/db/users';
import { addUploadedBook } from '../src/uploads/catalog-write';
import { calibreDate, CalibreRoot, type LibraryFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { addStage2Tables, setStage2Fields } from './helpers/stage2-fixture';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

async function makeEnv(setup: (lib: LibraryFixture) => Promise<void>, uploads = false) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  await setup(lib);
  const e = makeIndexerEnv(root.dir, {}, {}, {}, { uploads });
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const auth = { Authorization: `Bearer ${e.token()}` };
  const get = (p: string, query: Record<string, string | number> = {}) =>
    request(e.app).get(`/api/v1${p}`).query(query).set(auth);
  const titles = async (q: string) => {
    const res = await get('/books', { q, limit: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.books as { title: string }[]).map((b) => b.title).sort();
  };
  const reindex = async () => {
    e.db.prepare('UPDATE library_index_state SET reindex_requested_at = 1').run();
    await e.indexer.tick();
  };
  const bookId = (title: string) =>
    (e.db.prepare('SELECT id FROM books WHERE title = ?').get(title) as { id: string }).id;
  return { e, lib, libId, get, titles, reindex, bookId };
}

async function addBooks(lib: LibraryFixture) {
  addStage2Tables(lib);
  const a = await lib.addBook({
    title: '魔女の旅々10',
    authors: ['白石定規'],
    timestamp: calibreDate(new Date(BASE)),
  });
  setStage2Fields(lib, a, {
    illustrators: ['あずーる', 'ＢＢ画伯'],
    identifiers: { amazon_jp: 'B0AAAAAAAA', bookwalker: 'abc-def', ISBN: '9784000000000' },
  });
  const b = await lib.addBook({
    title: '別の本',
    authors: ['あずーる'],
    timestamp: calibreDate(new Date(BASE + 60_000)),
  });
  const c = await lib.addBook({
    title: 'Comma, Book',
    authors: ['著者'],
    timestamp: calibreDate(new Date(BASE + 120_000)),
  });
  setStage2Fields(lib, c, { illustrators: ['Smith, John'] });
  return { a, b, c };
}

describe('migration 30: illustrators and identifiers', () => {
  it('adds the tables and asks every library for a full index once', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Up to 29, with one library, then 30.
    for (const m of MIGRATIONS.filter((x) => x.version <= 29)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO libraries (id, folder, name, discovered_at, updated_at) VALUES ('L', 'a', 'a', ?, ?)`,
    ).run(now, now);
    db.prepare(`INSERT INTO library_index_state (library_id) VALUES ('L')`).run();
    expect(migrate(db)).toBeGreaterThanOrEqual(30);
    expect(db.prepare('SELECT reindex_requested_at AS r FROM library_index_state').get()).toEqual({
      r: 1,
    });
    for (const t of ['illustrators', 'book_illustrators', 'book_identifiers']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(t)).toBeTruthy();
    }
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT book_id FROM book_illustrators WHERE illustrator_id = 1`)
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/book_illustrators_illustrator/);
    db.close();
  });
});

describe('the ingest reads #illustrator and identifiers', () => {
  it('stores several names in Calibre order, identifiers with lower-case types, and serves them', async () => {
    const c = await makeEnv(async (lib) => void (await addBooks(lib)));
    const id = c.bookId('魔女の旅々10');
    const detail = await c.get(`/books/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.illustrators).toEqual(['あずーる', 'ＢＢ画伯']);
    expect(detail.body.identifiers).toEqual({
      amazon_jp: 'B0AAAAAAAA',
      bookwalker: 'abc-def',
      isbn: '9784000000000',
    });
    const other = await c.get(`/books/${c.bookId('別の本')}`);
    expect(other.body.illustrators).toEqual([]);
    expect(other.body.identifiers).toEqual({});
    // A comma inside one name stays one name (the column holds names, "&" separates them).
    const comma = await c.get(`/books/${c.bookId('Comma, Book')}`);
    expect(comma.body.illustrators).toEqual(['Smith, John']);
    // Every list summary carries the illustrators (the byline and the offline search use them).
    const list = await c.get('/books', { limit: 10 });
    const row = (list.body.books as { title: string; illustrators: string[] }[]).find(
      (b) => b.title === '魔女の旅々10',
    );
    expect(row?.illustrators).toEqual(['あずーる', 'ＢＢ画伯']);
  });

  it('follows changes in Calibre, prunes unused names and changes nothing on a rerun', async () => {
    let ids: { a: number; b: number; c: number } = { a: 0, b: 0, c: 0 };
    const c = await makeEnv(async (lib) => {
      ids = await addBooks(lib);
    });
    const before = c.e.db.prepare('SELECT meta_hash FROM book_sources ORDER BY id').all();
    await c.reindex();
    expect(c.e.db.prepare('SELECT meta_hash FROM book_sources ORDER BY id').all()).toEqual(before);
    setStage2Fields(c.lib, ids.a, {
      illustrators: ['ＢＢ画伯', '新しい人'],
      identifiers: { amazon_jp: 'B0BBBBBBBB' },
    });
    await c.reindex();
    const d = await c.get(`/books/${c.bookId('魔女の旅々10')}`);
    expect(d.body.illustrators).toEqual(['ＢＢ画伯', '新しい人']);
    expect(d.body.identifiers).toEqual({ amazon_jp: 'B0BBBBBBBB' });
    const names = c.e.db.prepare('SELECT name FROM illustrators ORDER BY name').all();
    expect(names).toEqual([{ name: 'Smith, John' }, { name: '新しい人' }, { name: 'ＢＢ画伯' }]);
  });

  it('finds the column by its label whatever its id, and works without it', async () => {
    const c = await makeEnv(async (lib) => {
      const id = await lib.addBook({ title: 'Book', authors: ['A'] });
      lib.exec((db) => {
        db.exec(`
          CREATE TABLE custom_columns ( id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
            name TEXT NOT NULL, datatype TEXT NOT NULL, mark_for_delete BOOL DEFAULT 0 NOT NULL,
            editable BOOL DEFAULT 1 NOT NULL, display TEXT DEFAULT '{}' NOT NULL,
            is_multiple BOOL DEFAULT 0 NOT NULL, normalized BOOL NOT NULL, UNIQUE(label));
          INSERT INTO custom_columns (id, label, name, datatype, is_multiple, normalized)
            VALUES (3, 'characters', 'Characters', 'int', 0, 0),
                   (7, 'illustrator', 'Illustrator', 'text', 1, 1);
          CREATE TABLE custom_column_7 ( id INTEGER PRIMARY KEY AUTOINCREMENT,
            value TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT '', UNIQUE(value));
          CREATE TABLE books_custom_column_7_link ( id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL, value INTEGER NOT NULL, UNIQUE(book, value));
          INSERT INTO custom_column_7 (id, value) VALUES (1, 'Zed'), (2, 'Amy');
        `);
        // Calibre's order is the link rows' order, not the names'.
        db.prepare(
          'INSERT INTO books_custom_column_7_link (book, value) VALUES (?, 1), (?, 2)',
        ).run(id, id);
      });
    });
    const d = await c.get(`/books/${c.bookId('Book')}`);
    expect(d.body.illustrators).toEqual(['Zed', 'Amy']);
    expect(d.body.identifiers).toEqual({});

    const plain = await makeEnv(async (lib) => void (await lib.addBook({ title: 'Plain' })));
    const p = await plain.get(`/books/${plain.bookId('Plain')}`);
    expect(p.status).toBe(200);
    expect(p.body.illustrators).toEqual([]);
    expect(p.body.identifiers).toEqual({});
  });

  it('gives an uploaded book neither', async () => {
    const c = await makeEnv(async (lib) => void (await addBooks(lib)), true);
    const user = listUsers(c.e.db)[0];
    expect(user).toBeTruthy();
    const bookId = randomUUID();
    addUploadedBook(c.e.db, {
      bookId,
      libraryId: c.libId,
      title: 'アップロード',
      authors: ['あずーる'],
      series: null,
      filePath: 'x.epub',
      fileSize: 1,
      sha256: 'x',
      hasCover: false,
      now: BASE,
    });
    const d = await c.get(`/books/${bookId}`);
    expect(d.status).toBe(200);
    expect(d.body.source).toBe('upload');
    expect(d.body.illustrators).toEqual([]);
    expect(d.body.identifiers).toEqual({});
  });
});

describe('searching illustrators', () => {
  it('has an illustrator: field with =, any-of, quotes, regex and negation, folded', async () => {
    const c = await makeEnv(async (lib) => void (await addBooks(lib)));
    expect(await c.titles('illustrator:あずーる')).toEqual(['魔女の旅々10']);
    expect(await c.titles('illustrator:bb画伯')).toEqual(['魔女の旅々10']);
    expect(await c.titles('illustrator:=ＢＢ画伯')).toEqual(['魔女の旅々10']);
    expect(await c.titles('illustrator:=BB')).toEqual([]);
    expect(await c.titles('illustrator:"Smith, John"')).toEqual(['Comma, Book']);
    expect(await c.titles('illustrator:"Smith, John",あずーる')).toEqual([
      'Comma, Book',
      '魔女の旅々10',
    ]);
    expect(await c.titles('illustrator:/^Smi/')).toEqual(['Comma, Book']);
    expect(await c.titles('-illustrator:あずーる')).toEqual(['Comma, Book', '別の本']);
    // author: stays authors only.
    expect(await c.titles('author:あずーる')).toEqual(['別の本']);
  });

  it('matches illustrator names in plain text, like author names', async () => {
    const c = await makeEnv(async (lib) => void (await addBooks(lib)));
    expect(await c.titles('あずーる')).toEqual(['別の本', '魔女の旅々10']);
    expect(await c.titles('ｓｍｉｔｈ')).toEqual(['Comma, Book']);
    expect(await c.titles('-あずーる')).toEqual(['Comma, Book']);
  });
});
