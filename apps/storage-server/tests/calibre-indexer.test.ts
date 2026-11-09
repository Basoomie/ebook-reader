import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkIndexerConfig, snapshotFile } from '../src/calibre/indexer';
import { parseCalibreDate } from '../src/calibre/ingest';
import {
  getIndexState,
  listLibraries,
  normalizeLanguage,
  requestReindex,
  updateLibrary,
} from '../src/calibre/libraries';
import { listBooksFor } from '../src/catalog/queries';
import { parseCalibreConfig } from '../src/config';
import { CalibreRoot, copyRealFixture, fingerprint } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { testCalibreConfig } from './helpers/test-app';

const envs: IndexerEnv[] = [];
function env(dir: string, overrides = {}): IndexerEnv {
  const e = makeIndexerEnv(dir, overrides);
  envs.push(e);
  return e;
}
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const OWNER = { id: 'test' };

interface CatalogBook {
  id: string;
  title: string;
  description: string | null;
  publisher: string | null;
  published_at: number | null;
  series_index: number | null;
  series: string | null;
  calibre_id: number;
  calibre_uuid: string;
  file_path: string;
  missing_at: number | null;
}

function books(db: Database.Database): CatalogBook[] {
  return db
    .prepare(
      `SELECT b.id, b.title, b.description, b.publisher, b.published_at, b.series_index,
              se.name AS series, s.calibre_id, s.calibre_uuid, s.file_path, s.missing_at
       FROM books b JOIN book_sources s ON s.book_id = b.id
       LEFT JOIN series se ON se.id = b.series_id ORDER BY s.calibre_id`,
    )
    .all() as CatalogBook[];
}

function authorsOf(db: Database.Database, bookId: string): string[] {
  return (
    db
      .prepare(
        `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
         WHERE ba.book_id = ? ORDER BY ba.position`,
      )
      .all(bookId) as { name: string }[]
  ).map((r) => r.name);
}

function tagsOf(db: Database.Database, bookId: string): string[] {
  return (
    db
      .prepare(
        `SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
         WHERE bt.book_id = ? ORDER BY t.name`,
      )
      .all(bookId) as { name: string }[]
  ).map((r) => r.name);
}

describe('indexing a library made by real Calibre', () => {
  it('waits for a language, then indexes the EPUB books from metadata.db only', async () => {
    const { root, folder } = copyRealFixture();
    const before = fingerprint(root);
    const e = env(root);
    await e.indexer.start({ timer: false });

    // Discovered, but off and unread until the user sets a language.
    const [lib] = listLibraries(e.db);
    expect(lib).toMatchObject({ folder, enabled: false, language: null, available: true });
    expect(books(e.db)).toHaveLength(0);
    expect(fs.existsSync(snapshotFile(e.calibre.cacheDir, lib.id))).toBe(false);
    expect(e.logs.join('\n')).toContain('stays off until you set its language');

    enableLibrary(e.db, folder);
    await e.indexer.tick();

    const all = books(e.db);
    // 6 Calibre books; "PDFだけの本" has no EPUB.
    expect(all.map((b) => b.title)).toEqual([
      '薬屋のひとりごと 1',
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 外伝',
      '共著の本',
      '両方ある本',
    ]);
    const [b1, b2, b3, b4, b6] = all;
    expect(authorsOf(e.db, b1.id)).toEqual(['日向夏']);
    expect(tagsOf(e.db, b1.id)).toEqual(['ミステリー', 'ライトノベル']);
    expect(b1).toMatchObject({
      series: '薬屋のひとりごと',
      series_index: 1,
      publisher: '主婦の友社',
      published_at: Date.UTC(2014, 7, 29),
      description: '<p>花街の薬屋で働く<b>猫猫</b>の物語。</p>',
      file_path: 'Ri Xiang Xia/Yao Wu nohitorigoto 1 (1)/Yao Wu nohitorigoto 1 - Ri Xiang Xia.epub',
      calibre_uuid: '536add88-1287-44cd-af17-8926c271733c',
    });
    expect(b2.published_at).toBeNull(); // Calibre's "undefined date"
    expect(b3.series_index).toBe(1.5);
    expect(authorsOf(e.db, b4.id)).toEqual(['著者二', '著者一']); // Calibre's order
    expect(b6.file_path.endsWith('.epub')).toBe(true);

    const [indexed] = listLibraries(e.db);
    expect(indexed.calibreLibraryUuid).toBe('40c5b270-b49b-49f8-a138-da7bf0bae7dd');
    expect(getIndexState(e.db, lib.id)).toMatchObject({
      status: 'idle',
      booksIndexed: 5,
      booksMissing: 0,
      booksSkipped: 0,
      lastError: null,
    });
    expect(fs.existsSync(snapshotFile(e.calibre.cacheDir, lib.id))).toBe(true);

    // Nothing in the Calibre folder was changed or created.
    expect(fingerprint(root)).toEqual(before);
  });
});

describe('discovery', () => {
  it('finds folders with a metadata.db one level down only', async () => {
    const root = new CalibreRoot();
    root.library('japanese-library');
    root.library('english-library');
    root.library(path.join('nested', 'too-deep'));
    root.library('.hidden');
    fs.mkdirSync(path.join(root.dir, 'ttu-reader-data'));
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    expect(listLibraries(e.db).map((l) => l.folder)).toEqual([
      'english-library',
      'japanese-library',
    ]);
  });

  it('accepts a library at the root itself', async () => {
    const root = new CalibreRoot();
    root.library('');
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    expect(listLibraries(e.db).map((l) => [l.folder, l.name])).toEqual([['', 'Calibre']]);
  });

  it('marks a library unavailable when its metadata.db goes away, keeping its books', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    enableLibrary(e.db, 'a');
    await e.indexer.tick();
    fs.renameSync(lib.dbFile, `${lib.dbFile}.bak`);
    await e.indexer.tick();
    expect(listLibraries(e.db)[0].available).toBe(false);
    expect(books(e.db)).toHaveLength(1);
    expect(books(e.db)[0].missing_at).toBeNull();
  });
});

describe('library settings', () => {
  it('validates language tags and never enables a library without one', async () => {
    expect(normalizeLanguage('JA')).toBe('ja');
    expect(normalizeLanguage('en-gb')).toBe('en-GB');
    expect(normalizeLanguage('japanese')).toBeNull();
    expect(normalizeLanguage('j')).toBeNull();
    expect(normalizeLanguage('en_US')).toBeNull();

    const root = new CalibreRoot();
    root.library('a');
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const [lib] = listLibraries(e.db);
    expect(() => updateLibrary(e.db, lib.id, { enabled: true })).toThrow(/Set a language/);
    expect(() => updateLibrary(e.db, lib.id, { language: 'nonsense!' })).toThrow(/not a valid/);
    // The database refuses it too.
    expect(() => e.db.prepare('UPDATE libraries SET enabled = 1').run()).toThrow(/CHECK/);
    const updated = updateLibrary(e.db, lib.id, { language: 'ja', name: '日本語', enabled: true });
    expect(updated).toMatchObject({ language: 'ja', name: '日本語', enabled: true });
  });
});

describe('change detection and snapshots', () => {
  it('does not copy or re-ingest an unchanged metadata.db', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    const snap = snapshotFile(e.calibre.cacheDir, id);
    const snapMtime = fs.statSync(snap).mtimeMs;
    const indexedAt = getIndexState(e.db, id).indexedAt;

    await e.indexer.tick();
    await e.indexer.tick();
    expect(fs.statSync(snap).mtimeMs).toBe(snapMtime);
    expect(getIndexState(e.db, id).indexedAt).toBe(indexedAt);
    expect(e.logs.filter((l) => l.includes('indexed library'))).toHaveLength(1);
  });

  it('waits until metadata.db has settled and Calibre has no journal', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    const e = env(root.dir, { settleSeconds: 600 });
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');

    await e.indexer.tick();
    expect(getIndexState(e.db, id).status).toBe('settling');
    expect(books(e.db)).toHaveLength(0);

    lib.age(3600);
    fs.writeFileSync(`${lib.dbFile}-journal`, '');
    await e.indexer.tick();
    expect(getIndexState(e.db, id).status).toBe('settling');
    expect(books(e.db)).toHaveLength(0);

    fs.unlinkSync(`${lib.dbFile}-journal`);
    await e.indexer.tick();
    expect(getIndexState(e.db, id).status).toBe('idle');
    expect(books(e.db)).toHaveLength(1);
  });

  it('reports a WAL-mode metadata.db as an error instead of reading it', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    const db = new Database(lib.dbFile);
    db.pragma('journal_mode = WAL');
    db.close();
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    await e.indexer.tick();
    const state = getIndexState(e.db, id);
    expect(state.status).toBe('error');
    expect(state.lastError).toMatch(/WAL mode/);
    expect(books(e.db)).toHaveLength(0);
    // A persisting problem is logged once, not on every poll.
    expect(e.logs.filter((l) => l.includes('WAL mode'))).toHaveLength(1);
  });

  it('re-indexes on request even when metadata.db did not change', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    requestReindex(e.db, id, false);
    await e.indexer.tick();
    expect(e.logs.filter((l) => l.includes('indexed library'))).toHaveLength(2);
    expect(getIndexState(e.db, id).reindexRequestedAt).toBeNull();
  });
});

describe('upserts and missing books', () => {
  it('keeps reader IDs, follows metadata changes and flags removed books missing', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    const c1 = await lib.addBook({ title: 'One', authors: ['A'], tags: ['x'] });
    const c2 = await lib.addBook({ title: 'Two', authors: ['B'], series: { name: 'S', index: 2 } });
    await lib.addBook({ title: 'Three', authors: ['A'] });
    const e = env(root.dir, { maxMissingPercent: 100 });
    await e.indexer.start({ timer: false });
    const libId = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    const ids = new Map(books(e.db).map((b) => [b.calibre_uuid, b.id]));
    expect(ids.size).toBe(3);

    lib.setTitle(c1, 'One (revised)');
    await e.indexer.tick();
    const one = books(e.db).find((b) => b.calibre_id === c1)!;
    expect(one.title).toBe('One (revised)');
    expect(one.id).toBe(ids.get(one.calibre_uuid));

    const uuid2 = books(e.db).find((b) => b.calibre_id === c2)!.calibre_uuid;
    lib.removeBook(c2);
    await e.indexer.tick();
    const two = books(e.db).find((b) => b.calibre_uuid === uuid2)!;
    expect(two.missing_at).not.toBeNull(); // flagged, not deleted
    expect(listBooksFor(e.db, OWNER).books.map((b) => b.title)).not.toContain('Two');
    expect(getIndexState(e.db, libId)).toMatchObject({ booksIndexed: 2, booksMissing: 1 });
    // A missing book keeps its metadata (its series stays).
    expect(e.db.prepare('SELECT name FROM series').all()).toEqual([{ name: 'S' }]);

    // Calibre gets the book back with the same UUID (e.g. restored): same reader ID.
    await lib.addBook({ uuid: uuid2, title: 'Two', authors: ['B'] });
    await e.indexer.tick();
    const back = books(e.db).find((b) => b.calibre_uuid === uuid2)!;
    expect(back.id).toBe(two.id);
    expect(back.missing_at).toBeNull();
  });

  it('drops author, series and tag names nothing refers to any more', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    const c = await lib.addBook({
      title: 'One',
      authors: ['Old'],
      tags: ['t'],
      series: { name: 'S', index: 1 },
    });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    enableLibrary(e.db, 'a');
    await e.indexer.tick();
    lib.exec((db) => {
      db.prepare('DELETE FROM books_series_link WHERE book = ?').run(c);
      db.prepare('DELETE FROM books_tags_link WHERE book = ?').run(c);
      db.prepare("UPDATE authors SET name = 'New'").run();
      db.prepare("UPDATE books SET last_modified = '2030-01-01 00:00:00+00:00'").run();
    });
    await e.indexer.tick();
    expect(e.db.prepare('SELECT name FROM series').all()).toEqual([]);
    expect(e.db.prepare('SELECT name FROM tags').all()).toEqual([]);
    expect(e.db.prepare('SELECT name FROM authors').all()).toEqual([{ name: 'New' }]);
  });

  it('skips books without an EPUB or without a UUID', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'EPUB' });
    await lib.addBook({ title: 'PDF only', formats: ['PDF'] });
    await lib.addBook({ title: 'Both', formats: ['PDF', 'EPUB'] });
    await lib.addBook({ title: 'No UUID', uuid: null });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    expect(books(e.db).map((b) => b.title)).toEqual(['EPUB', 'Both']);
    expect(getIndexState(e.db, id).booksSkipped).toBe(1);
  });

  it('stops before flagging a large share of a library missing, unless told to', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    const calibreIds: number[] = [];
    for (let i = 0; i < 10; i++)
      calibreIds.push(await lib.addBook({ title: `B${i}`, cover: 'none' }));
    const e = env(root.dir, { maxMissingPercent: 20 });
    await e.indexer.start({ timer: false });
    const id = enableLibrary(e.db, 'a');
    await e.indexer.tick();

    for (const c of calibreIds.slice(0, 3)) lib.removeBook(c);
    await e.indexer.tick();
    expect(books(e.db).filter((b) => b.missing_at !== null)).toHaveLength(0);
    expect(getIndexState(e.db, id).lastWarning).toMatch(/3 of 10 books .* NOT flagged missing/);

    requestReindex(e.db, id, true);
    await e.indexer.tick();
    expect(books(e.db).filter((b) => b.missing_at !== null)).toHaveLength(3);
    expect(getIndexState(e.db, id)).toMatchObject({ allowMassMissing: false, lastWarning: null });
  });

  it('indexes in batches across many books', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    for (let i = 0; i < 25; i++) await lib.addBook({ title: `B${i}`, cover: 'none' });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    enableLibrary(e.db, 'a');
    // Small batches exercise the keyset paging over Calibre ids.
    const { ingestSnapshot } = await import('../src/calibre/ingest');
    const [libRow] = listLibraries(e.db);
    await e.indexer.tick();
    const result = await ingestSnapshot(e.db, snapshotFile(e.calibre.cacheDir, libRow.id), {
      libraryId: libRow.id,
      maxMissingPercent: 20,
      allowMassMissing: false,
      batchSize: 4,
    });
    expect(result).toMatchObject({ total: 25, added: 0, unchanged: 25, present: 25 });
  });
});

describe('library identity', () => {
  it('follows a renamed library folder, keeping its ID and books', async () => {
    const root = new CalibreRoot();
    const lib = root.library('old-name');
    await lib.addBook({ title: 'One' });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    const oldId = enableLibrary(e.db, 'old-name', 'en');
    await e.indexer.tick();
    const [book] = books(e.db);

    fs.renameSync(lib.dir, path.join(root.dir, 'new-name'));
    await e.indexer.tick();
    const libs = listLibraries(e.db);
    expect(libs.map((l) => [l.folder, l.available, l.enabled])).toEqual([
      ['new-name', true, false],
      ['old-name', false, true],
    ]);

    enableLibrary(e.db, 'new-name', 'en');
    await e.indexer.tick();
    const [merged] = listLibraries(e.db);
    expect(listLibraries(e.db)).toHaveLength(1);
    expect(merged).toMatchObject({ id: oldId, folder: 'new-name', available: true });
    expect(books(e.db).map((b) => b.id)).toEqual([book.id]);
  });

  it('refuses a second folder holding the same Calibre library', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'One' });
    fs.cpSync(lib.dir, path.join(root.dir, 'a-copy'), { recursive: true });
    const e = env(root.dir);
    await e.indexer.start({ timer: false });
    enableLibrary(e.db, 'a');
    const copyId = enableLibrary(e.db, 'a-copy');
    await e.indexer.tick();
    expect(getIndexState(e.db, copyId)).toMatchObject({ status: 'error' });
    expect(getIndexState(e.db, copyId).lastError).toMatch(/same Calibre library as "a"/);
    expect(books(e.db)).toHaveLength(1);
  });
});

describe('safety checks', () => {
  it('refuses a writable Calibre folder unless explicitly allowed', async () => {
    const root = new CalibreRoot();
    const cfg = testCalibreConfig({ dir: root.dir, requireReadonly: true });
    expect(await checkIndexerConfig(cfg, makeTempDir('db'), makeTempDir('data'))).toMatch(
      /is writable/,
    );
    cfg.requireReadonly = false;
    expect(await checkIndexerConfig(cfg, makeTempDir('db'), makeTempDir('data'))).toBeNull();
  });

  it('refuses caches, databases or data inside the Calibre folder (and vice versa)', async () => {
    const root = new CalibreRoot();
    const inside = path.join(root.dir, 'cache');
    fs.mkdirSync(inside);
    const base = testCalibreConfig({ dir: root.dir });
    const db = makeTempDir('db');
    const data = makeTempDir('data');
    expect(await checkIndexerConfig({ ...base, cacheDir: inside }, db, data)).toMatch(
      /CACHE_DIR .* overlap/,
    );
    expect(await checkIndexerConfig(base, inside, data)).toMatch(/DB_DIR .* overlap/);
    expect(await checkIndexerConfig(base, db, inside)).toMatch(/DATA_DIR .* overlap/);
    expect(await checkIndexerConfig({ ...base, cacheDir: data }, db, data)).toMatch(/overlap/);
    expect(
      await checkIndexerConfig({ ...base, dir: path.join(root.dir, 'nope') }, db, data),
    ).toMatch(/does not exist/);
  });

  it('stays off with a clear status when the folders are wrong', async () => {
    const e = env(path.join(makeTempDir('calibre'), 'not-mounted'));
    await e.indexer.start({ timer: false });
    expect(e.indexer.status).toMatchObject({ enabled: false });
    expect(e.indexer.status.error).toMatch(/CALIBRE_DIR does not exist/);
    await e.indexer.tick(); // no-op, no throw
  });
});

describe('settings', () => {
  it('falls back to defaults on bad values and reports them', () => {
    const warnings: string[] = [];
    const cfg = parseCalibreConfig(
      {
        CALIBRE_DIR: '/calibre',
        CALIBRE_POLL_SECONDS: '1',
        CALIBRE_SETTLE_SECONDS: 'soon',
        CALIBRE_MAX_MISSING_PERCENT: '150',
        THUMB_CONCURRENCY: '1.5',
        THUMB_PER_SECOND: '0',
        THUMB_BACKGROUND: 'maybe',
        CALIBRE_REQUIRE_READONLY: 'false',
      },
      warnings,
    );
    expect(cfg).toMatchObject({
      pollSeconds: 60,
      settleSeconds: 30,
      maxMissingPercent: 20,
      thumbConcurrency: 1,
      thumbPerSecond: 0,
      thumbBackground: true,
      requireReadonly: false,
    });
    expect(warnings).toHaveLength(5);
    expect(parseCalibreConfig({}, []).dir).toBeNull();
  });

  it('parses Calibre timestamps', () => {
    expect(parseCalibreDate('2026-11-09 04:00:11.251060+00:00')).toBe(
      Date.UTC(2026, 10, 9, 4, 0, 11, 251),
    );
    expect(parseCalibreDate('2014-08-29 09:00:00+09:00')).toBe(Date.UTC(2014, 7, 29, 0, 0, 0));
    expect(parseCalibreDate('0101-01-01 00:00:00+00:00')).toBeNull();
    expect(parseCalibreDate('garbage')).toBeNull();
    expect(parseCalibreDate(null)).toBeNull();
  });
});
