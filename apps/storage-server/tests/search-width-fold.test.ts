/**
 * fix-search-width-folding: library search matches full-width and half-width letters and
 * digits alike (NFKC + lower case on both sides, catalog/fold.ts) in plain text, author:,
 * series:, tag:, the `=` forms, group name filters, counts and smart collections, while
 * /regex/ patterns, opening a group and the displayed names keep the original text.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDED_COLUMNS, fillSearchFolds, foldForSearch } from '../src/catalog/fold';
import { planBooks } from '../src/catalog/queries';
import { matcherSql } from '../src/catalog/search-sql';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { listUsers } from '../src/db/users';
import { addUploadedBook } from '../src/uploads/catalog-write';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);
/** て + a separate voiced mark (U+3099), as some names are stored (decomposed). */
const DECOMPOSED_DE = `て${String.fromCharCode(0x3099)}`;

const BOOKS: FixtureBook[] = [
  { title: 'ＮＯ推理、ＮＯ探偵？', authors: ['ＡＢＣ太郎'], tags: ['ＳＦ'] },
  { title: 'NO推理の本', authors: ['abc花子'], tags: ['SF'] },
  { title: '魔女の旅々２０', authors: ['白石定規'], series: { name: 'Ｒｅ：ゼロ', index: 20 } },
  { title: '魔女の旅々19', authors: ['白石定規'] },
  { title: 'ＧＪ部', authors: ['ＧＪ'] },
  { title: 'GJ部中等部1', authors: ['GJ'] },
  { title: 'すいり手帳', authors: ['著者'] },
  { title: '100％ Pure', authors: ['著者'] },
  { title: '100x Pure', authors: ['著者'] },
  { title: `ゆめを見${DECOMPOSED_DE}いる`, authors: ['著者'] },
];

async function env(books: FixtureBook[] = BOOKS) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const calibreIds: number[] = [];
  for (const [i, b] of books.entries()) {
    calibreIds.push(
      await lib.addBook({ timestamp: calibreDate(new Date(BASE + i * 60_000)), ...b }),
    );
  }
  const e = makeIndexerEnv(root.dir);
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const user = listUsers(e.db)[0];
  const auth = { Authorization: `Bearer ${e.token()}` };
  const get = (path: string, query: Record<string, string | number> = {}) =>
    request(e.app).get(`/api/v1${path}`).query(query).set(auth);
  /** Titles found, newest first (displayed as stored). */
  const titles = async (q: string, extra: Record<string, string | number> = {}) => {
    const res = await get('/books', { q, limit: 100, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.books as { title: string }[]).map((b) => b.title);
  };
  /** Same, sorted, when only the set matters. */
  const found = async (q: string, extra: Record<string, string | number> = {}) =>
    (await titles(q, extra)).sort();
  return { e, lib, libId, user, auth, get, titles, found, calibreIds };
}

describe('library search folds full-width and half-width (GET /api/v1/books?q=)', () => {
  it('finds the reported examples in both directions', async () => {
    const c = await env();
    const both = ['NO推理の本', 'ＮＯ推理、ＮＯ探偵？'];
    expect(await c.found('NO推理')).toEqual(both);
    expect(await c.found('ＮＯ推理')).toEqual(both);
    expect(await c.found('no推理')).toEqual(both);
    expect(await c.found('魔女の旅々20')).toEqual(['魔女の旅々２０']);
    expect(await c.found('魔女の旅々２０')).toEqual(['魔女の旅々２０']);
    expect(await c.found('魔女の旅々１９')).toEqual(['魔女の旅々19']);
    expect(await c.found('gj')).toEqual(['GJ部中等部1', 'ＧＪ部']);
    expect(await c.found('ｇｊ部')).toEqual(['GJ部中等部1', 'ＧＪ部']);
  });

  it('keeps the displayed names as stored', async () => {
    const c = await env();
    const res = await c.get('/books', { q: 'gj' });
    const book = (res.body.books as { title: string; authors: { name: string }[] }[]).find(
      (b) => b.title === 'ＧＪ部',
    );
    expect(book?.authors.map((a) => a.name)).toEqual(['ＧＪ']);
    expect(
      c.e.db.prepare("SELECT name FROM tags WHERE name_fold = 'sf' ORDER BY name").all(),
    ).toEqual([{ name: 'SF' }, { name: 'ＳＦ' }]);
  });

  it('folds author:, series: and tag:, their = forms and negation', async () => {
    const c = await env();
    expect(await c.found('author:abc')).toEqual(['NO推理の本', 'ＮＯ推理、ＮＯ探偵？']);
    expect(await c.found('author:ａｂｃ太')).toEqual(['ＮＯ推理、ＮＯ探偵？']);
    expect(await c.found('author:=abc太郎')).toEqual(['ＮＯ推理、ＮＯ探偵？']);
    expect(await c.found('author:=abc')).toEqual([]);
    expect(await c.found('author:=gj')).toEqual(['GJ部中等部1', 'ＧＪ部']);
    expect(await c.found('series:re:ゼロ')).toEqual(['魔女の旅々２０']);
    expect(await c.found('series:="RE:ゼロ"')).toEqual(['魔女の旅々２０']);
    expect(await c.found('tag:sf')).toEqual(['NO推理の本', 'ＮＯ推理、ＮＯ探偵？']);
    expect(await c.found('tag:=ＳＦ')).toEqual(['NO推理の本', 'ＮＯ推理、ＮＯ探偵？']);
    expect(await c.found('tag:=s')).toEqual([]);
    expect(await c.found('推理 -tag:=sf')).toEqual([]);
    expect(await c.found('-author:gj 部')).toEqual([]);
  });

  it('runs /regex/ on the original text', async () => {
    const c = await env();
    expect(await c.found('/ＧＪ/')).toEqual(['ＧＪ部']);
    expect(await c.found('/GJ/')).toEqual(['GJ部中等部1']);
    expect(await c.found('/gj/i')).toEqual(['GJ部中等部1']);
    expect(await c.found('/２０$/')).toEqual(['魔女の旅々２０']);
    expect(await c.found('author:/^ＧＪ$/')).toEqual(['ＧＪ部']);
  });

  it('keeps ASCII case-insensitivity, kana distinct and LIKE characters literal', async () => {
    const c = await env();
    expect(await c.found('Gj部中')).toEqual(['GJ部中等部1']);
    expect(await c.found('author:ABC花')).toEqual(['NO推理の本']);
    expect(await c.found('スイリ')).toEqual([]);
    expect(await c.found('すいり')).toEqual(['すいり手帳']);
    expect(await c.found('100%')).toEqual(['100％ Pure']);
    expect(await c.found('100％')).toEqual(['100％ Pure']);
    expect(await c.found('100_')).toEqual([]);
    expect(await c.found('！')).toEqual([]);
  });

  it('finds a name stored with a separate voiced mark by the composed word', async () => {
    const c = await env();
    const stored = `ゆめを見${DECOMPOSED_DE}いる`;
    expect(await c.found('見でいる')).toEqual([stored]);
    expect(await c.found(`見${DECOMPOSED_DE}`)).toEqual([stored]);
  });

  it('folds counts, group name filters and smart collections the same way', async () => {
    const c = await env();
    expect((await c.get('/books/count', { q: 'gj' })).body.count).toBe(2);
    const groups = await c.get('/groups', { by: 'author', q: 'author:gj' });
    expect(groups.status).toBe(200);
    expect((groups.body.groups as { name: string }[]).map((g) => g.name).sort()).toEqual([
      'GJ',
      'ＧＪ',
    ]);

    const deviceId = randomUUID();
    expect(
      (await request(c.e.app).post('/api/v1/devices/register').set(c.auth).send({ deviceId }))
        .status,
    ).toBe(200);
    const sf = randomUUID();
    const push = await request(c.e.app)
      .post('/api/v1/sync')
      .set(c.auth)
      .send({
        changes: [
          {
            kind: 'collection',
            id: sf,
            updatedAt: BASE + 1,
            data: { name: 'SF', type: 'smart', query: 'tag:=ｓｆ' },
          },
        ],
      });
    expect(push.body.results[0].status).toBe('applied');
    const cards = await request(c.e.app).get('/api/v1/collections/cards').set(c.auth);
    const card = (cards.body.cards as { id: string; bookCount: number }[]).find((x) => x.id === sf);
    expect(card?.bookCount).toBe(2);
  });

  it('opens a group by its exact stored name', async () => {
    const c = await env();
    expect(await c.found('', { by: 'author', group: 'GJ' })).toEqual(['GJ部中等部1']);
    expect(await c.found('', { by: 'author', group: 'ＧＪ' })).toEqual(['ＧＪ部']);
    expect(await c.found('', { by: 'author', group: 'gj' })).toEqual([]);
  });

  it('keeps the query plans (books_added walk, small-set start)', async () => {
    const c = await env();
    // A small author set: SQLite may start from its books (search-sql.ts, SMALL_SET).
    const small = planBooks(c.e.db, c.user, { query: 'author:ａｂｃ' });
    expect(small.sql).toContain('name_fold LIKE ?');
    expect(small.sql).toContain('b.id IN (SELECT ba.book_id');
    expect(small.sql).not.toContain('+b.id IN (SELECT ba.book_id');
    // Text alone walks books in date order without sorting.
    const walk = planBooks(c.e.db, c.user, { query: 'ｇｊ' });
    const detail = (
      c.e.db.prepare(`EXPLAIN QUERY PLAN ${walk.sql}`).all(...walk.params) as { detail: string }[]
    ).map((r) => r.detail);
    expect(detail[0]).toBe('SCAN b USING INDEX books_added');
    expect(detail.join('\n')).not.toContain('TEMP B-TREE FOR ORDER BY');
  });
});

describe('folded copies', () => {
  it('builds text matches on <column>_fold, and every searched column has one', () => {
    const db = new Database(':memory:');
    migrate(db);
    for (const { table, column, fold } of FOLDED_COLUMNS) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(cols).toContain(column);
      expect(cols).toContain(fold);
    }
    for (const column of ['b.title', 'name', 'gn.name']) {
      expect(matcherSql(column, { kind: 'text', value: 'Ｘ', exact: false })).toEqual({
        sql: `${column}_fold LIKE ? ESCAPE '!'`,
        params: ['%x%'],
      });
      expect(matcherSql(column, { kind: 'text', value: 'Ｘ', exact: true })).toEqual({
        sql: `${column}_fold = ?`,
        params: ['x'],
      });
      expect(matcherSql(column, { kind: 'regex', source: 'Ｘ', ignoreCase: false })).toEqual({
        sql: `ttu_regexp(?, ?, ${column})`,
        params: ['Ｘ', ''],
      });
    }
    expect(foldForSearch('ＧＪ部２０　ｶﾞ')).toBe('gj部20 ガ');
    db.close();
  });

  it('are written by the indexer, updated with a new title and filled when missing', async () => {
    const c = await env();
    for (const { table, column, fold } of FOLDED_COLUMNS) {
      const rows = c.e.db.prepare(`SELECT ${column} AS v, ${fold} AS f FROM ${table}`).all() as {
        v: string;
        f: string | null;
      }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.f).toBe(foldForSearch(r.v));
    }

    c.lib.setTitle(c.calibreIds[3], 'ＸＹＺ新刊');
    await c.e.indexer.tick();
    expect(await c.found('xyz')).toEqual(['ＸＹＺ新刊']);

    c.e.db.prepare('UPDATE books SET title_fold = NULL').run();
    c.e.db.prepare('UPDATE tags SET name_fold = NULL').run();
    expect(fillSearchFolds(c.e.db)).toBe(BOOKS.length + 2);
    expect(fillSearchFolds(c.e.db)).toBe(0);
    expect(await c.found('gj')).toEqual(['GJ部中等部1', 'ＧＪ部']);
    expect(await c.found('tag:sf')).toHaveLength(2);
  });

  it('are written for an uploaded book, its authors and series', async () => {
    const c = await env([{ title: 'x', authors: ['a'] }]);
    const bookId = randomUUID();
    addUploadedBook(c.e.db, {
      bookId,
      libraryId: c.libId,
      title: 'ＵＰ本',
      authors: ['Ｕｐ著者'],
      series: { name: 'ＵＰシリーズ', index: 1 },
      filePath: 'x.epub',
      fileSize: 1,
      sha256: 'x',
      hasCover: false,
      now: BASE,
    });
    expect(c.e.db.prepare('SELECT title_fold FROM books WHERE id = ?').get(bookId)).toEqual({
      title_fold: 'up本',
    });
    expect(c.e.db.prepare("SELECT name_fold FROM authors WHERE name = 'Ｕｐ著者'").get()).toEqual({
      name_fold: 'up著者',
    });
    expect(
      c.e.db.prepare("SELECT name_fold FROM series WHERE name = 'ＵＰシリーズ'").get(),
    ).toEqual({ name_fold: 'upシリーズ' });
  });

  it('migration 16 adds empty columns that the fill backfills', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter((m) => m.version <= 15)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare(
      `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
       VALUES ('l', 'f', 'L', 'ja', 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
       VALUES ('b', 'l', 'ＧＪ部', 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO authors (name) VALUES ('ＡＢＣ')").run();
    db.prepare("INSERT INTO series (name) VALUES ('Ｓ')").run();
    db.prepare("INSERT INTO tags (name) VALUES ('ＴＡＧ')").run();
    expect(migrate(db)).toBe(16);
    expect(db.prepare('SELECT title, title_fold FROM books').get()).toEqual({
      title: 'ＧＪ部',
      title_fold: null,
    });
    expect(fillSearchFolds(db)).toBe(4);
    expect(db.prepare('SELECT title, title_fold FROM books').get()).toEqual({
      title: 'ＧＪ部',
      title_fold: 'gj部',
    });
    expect(db.prepare('SELECT name_fold FROM authors').get()).toEqual({ name_fold: 'abc' });
    expect(db.prepare('SELECT name_fold FROM tags').get()).toEqual({ name_fold: 'tag' });
    db.close();
  });
});
