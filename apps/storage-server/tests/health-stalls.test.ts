/**
 * The server's event-loop stalls (2026-11-26): the library-wide steps that held the server for
 * seconds now run in slices with the same results, and figure-only writes don't rebuild the
 * book-list caches. At the live size: scripts/health-stalls-timing.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { libraryIndex, libraryIndexAsync } from '../src/bookmeter/match';
import {
  bookListVersion,
  catalogVersion,
  noteCatalogWrite,
  noteFiguresWrite,
} from '../src/catalog/catalog-version';
import { presentBookCount } from '../src/cleanup/handoff';
import { readSnapshotBooks, readSnapshotBooksAsync } from '../src/cleanup/stage1';
import { sliced } from '../src/ratings/service';
import {
  medianPooledAverage,
  medianPooledAverageAsync,
  readScoreParams,
  saveRating,
  updateScoreParams,
  updateScoreParamsAsync,
} from '../src/ratings/store';
import { calibreDate, CalibreRoot, type LibraryFixture } from './helpers/calibre-fixture';
import { enableLibrary, type IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

async function env(): Promise<{ e: IndexerEnv; lib: LibraryFixture; ids: string[] }> {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const books = [
    { title: 'ソードアート・オンライン 1', authors: ['川原 礫'], tags: ['SF', 'ライトノベル'] },
    { title: 'ソードアート・オンライン 2', authors: ['川原 礫', 'abec'], tags: ['ライトノベル'] },
    { title: '本好きの下剋上 第一部', authors: ['香月 美夜'], formats: ['EPUB', 'PDF'] },
    { title: 'Beta', authors: ['Bob'], series: { name: 'B', index: 1 } },
    { title: 'Gamma', authors: ['Kim'], tags: ['b', 'A', 'c'] },
    { title: 'Delta', authors: ['Zed'] },
    { title: 'Epsilon', authors: ['Amy', 'Bob', 'Kim'] },
  ];
  for (const [i, b] of books.entries()) {
    await lib.addBook({ timestamp: calibreDate(new Date(BASE + i * 60_000)), sort: b.title, ...b });
  }
  const e = makeIndexerEnv(root.dir);
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const ids = (e.db.prepare('SELECT id FROM books ORDER BY rowid').all() as { id: string }[]).map(
    (r) => r.id,
  );
  return { e, lib, ids };
}

describe('the catalog versions', () => {
  it("moves the catalog's version for a figure, the book list's only for books", async () => {
    const { e } = await env();
    const cat = catalogVersion(e.db);
    const list = bookListVersion(e.db);
    noteFiguresWrite(e.db);
    expect(catalogVersion(e.db)).not.toBe(cat);
    expect(bookListVersion(e.db)).toBe(list);
    noteCatalogWrite(e.db);
    expect(bookListVersion(e.db)).not.toBe(list);
  });
});

describe("読書メーター's library index", () => {
  it('builds the same index in slices, and a saved rating keeps it', async () => {
    const { e, ids } = await env();
    e.db
      .prepare(
        "INSERT INTO book_identifiers (book_id, type, value) VALUES (?, 'bookmeter', ' 42 ')",
      )
      .run(ids[1]);
    // Missing books are left out, as before.
    e.db.prepare('UPDATE book_sources SET missing_at = 1 WHERE book_id = ?').run(ids[5]);
    noteCatalogWrite(e.db);
    const whole = libraryIndex(e.db);
    noteCatalogWrite(e.db);
    const sliced = await libraryIndexAsync(e.db);
    expect(sliced).not.toBe(whole);
    expect([...sliced.books.entries()]).toEqual([...whole.books.entries()]);
    expect([...sliced.bySavedId.entries()]).toEqual([...whole.bySavedId.entries()]);
    expect([...sliced.byAuthor.entries()]).toEqual([...whole.byAuthor.entries()]);
    expect([...sliced.byTitle.entries()]).toEqual([...whole.byTitle.entries()]);
    expect(sliced.books.has(ids[5])).toBe(false);
    expect(sliced.bySavedId.get('42')?.map((b) => b.id)).toEqual([ids[1]]);
    expect(sliced.books.get(ids[6])?.authors).toEqual(['Amy', 'Bob', 'Kim']);

    // A saved rating (a figure) keeps the index; a book change builds it again.
    saveRating(
      e.db,
      'amazon_jp',
      'B000000001',
      { kind: 'rating', avg: 4, count: 3, reviews: null },
      1,
    );
    noteFiguresWrite(e.db);
    expect(libraryIndex(e.db)).toBe(sliced);
    noteCatalogWrite(e.db);
    expect(libraryIndex(e.db)).not.toBe(sliced);
  });
});

describe('the Calibre snapshot', () => {
  it('reads the same books, formats and tags in slices', async () => {
    const { lib } = await env();
    const whole = readSnapshotBooks(lib.dbFile);
    const sliced = await readSnapshotBooksAsync(lib.dbFile);
    expect([...sliced.entries()]).toEqual([...whole.entries()]);
    expect(whole.size).toBe(7);
    expect([...whole.values()].find((b) => b.title === 'Gamma')?.tags).toEqual(['A', 'b', 'c']);
  });
});

describe('the present books', () => {
  it('counts a library from the index of migration 36', async () => {
    const { e, ids } = await env();
    const lib = (e.db.prepare('SELECT library_id AS l FROM books LIMIT 1').get() as { l: string })
      .l;
    expect(presentBookCount(e.db, lib)).toBe(7);
    e.db.prepare('UPDATE book_sources SET missing_at = 1 WHERE book_id = ?').run(ids[0]);
    noteCatalogWrite(e.db);
    expect(presentBookCount(e.db, lib)).toBe(6);
    const plan = e.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM book_sources
         WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL`,
      )
      .all(lib) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('COVERING INDEX book_sources_present');
  });
});

describe("store ratings' library-wide queries", () => {
  it('give the same rows in slices of identifiers as in one query', async () => {
    const { e, ids } = await env();
    const ins = e.db.prepare(
      "INSERT INTO book_identifiers (book_id, type, value) VALUES (?, 'amazon_jp', ?)",
    );
    ['B000000003', 'B000000001', 'B000000002', 'B000000001', 'B000000005', 'B000000004'].forEach(
      (v, i) => ins.run(ids[i], v),
    );
    const sql = `SELECT bi.value AS id, MIN(b.created_at) AS created FROM book_identifiers bi
      JOIN books b ON b.id = bi.book_id WHERE bi.type = @type AND {range}
      GROUP BY bi.value ORDER BY bi.value`;
    const whole = e.db.prepare(sql.replace('{range}', '1')).all({ type: 'amazon_jp' }) as {
      id: string;
    }[];
    for (const perSlice of [1, 2, 3, 100]) {
      expect(await sliced(e.db, 'amazon_jp', sql, {}, perSlice)).toEqual(whole);
    }
    expect(whole.map((r) => r.id)).toEqual([
      'B000000001',
      'B000000002',
      'B000000003',
      'B000000004',
      'B000000005',
    ]);
  });

  it('work the median and the scores out in slices as in one statement', async () => {
    const { e, ids } = await env();
    const ins = e.db.prepare(
      "INSERT INTO book_identifiers (book_id, type, value) VALUES (?, 'amazon_jp', ?)",
    );
    const figures = [
      [4.1, 10],
      [3.2, 400],
      [4.8, 3],
      [4.5, 77],
      [2.9, 12],
    ];
    figures.forEach(([avg, count], i) => {
      const id = `B00000010${i}`;
      ins.run(ids[i], id);
      saveRating(e.db, 'amazon_jp', id, { kind: 'rating', avg, count, reviews: null }, 1);
    });
    expect(await medianPooledAverageAsync(e.db)).toBe(medianPooledAverage(e.db));
    const scores = () =>
      e.db.prepare('SELECT id, rating_score AS s FROM books ORDER BY id').all() as unknown[];
    expect(await updateScoreParamsAsync(e.db, 3)).toBe(true);
    const sliced = scores();
    const params = readScoreParams(e.db);
    updateScoreParams(e.db, 20, 4.1);
    expect(updateScoreParams(e.db, params.c, params.m)).toBe(true);
    expect(scores()).toEqual(sliced);
    expect(await updateScoreParamsAsync(e.db, 3)).toBe(false);
  });
});
