/**
 * fix-count-file-identity: a character count or cover thumbnail made from a file is kept
 * when only Calibre's key changed (last_modified bumped by a metadata edit, or the book
 * folder moved) and the file is the same (size and modified time). A replaced file is
 * still counted / made again.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { fileIdentity, sameFile } from '../src/calibre/file-identity';
import { getCountRecord } from '../src/counts/count-records';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../src/db/migrations';
import { getThumbnailRecord } from '../src/thumbnails/thumbnails';
import { calibreDate, CalibreRoot, FixtureBook, LibraryFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

/** A stand-in counter (as in char-counts.test.ts): the EPUB's text is its count, BAD fails. */
function fakeCounter(): string {
  const file = path.join(makeTempDir('counter'), 'fake-count.cjs');
  fs.writeFileSync(
    file,
    `/*
 * epub-count-version: 1
 * build: 00000000fa4ec0de
 */
exports.EPUB_COUNT_VERSION = 1;
exports.countEpubForServer = async (blob) => {
  const text = Buffer.from(await blob.slice(0, 32).arrayBuffer()).toString('utf8').trim();
  if (text === 'BAD') throw new Error('not an EPUB');
  return { characters: Number(text) };
};
`,
  );
  return file;
}

async function setup(books: FixtureBook[]) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const ids = new Map<string, number>();
  for (const book of books) ids.set(book.title, await lib.addBook(book));
  const e = makeIndexerEnv(
    root.dir,
    {},
    {},
    { config: { background: true, timeoutSeconds: 60 }, counterFile: fakeCounter() },
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'a');
  const bookId = (title: string) =>
    (e.db.prepare('SELECT id FROM books WHERE title = ?').get(title) as { id: string }).id;
  /** One indexer poll and the whole counting pass. */
  const poll = async () => {
    await e.indexer.tick();
    await e.counts.idle();
  };
  const status = async (title: string) =>
    (
      await request(e.app)
        .get(`/api/v1/books/${bookId(title)}`)
        .set('Authorization', `Bearer ${e.token()}`)
    ).body as { charCount: number | null; charCountStatus: string };
  return { e, root, lib, ids, bookId, poll, status };
}

/** A metadata-only edit in Calibre: last_modified moves, no file is written. */
function touchMetadata(lib: LibraryFixture, calibreId: number, offsetMs = 5000): void {
  lib.exec((db) =>
    db
      .prepare('UPDATE books SET last_modified = ? WHERE id = ?')
      .run(calibreDate(new Date(Date.now() + offsetMs)), calibreId),
  );
  lib.age();
}

describe('character counts keep unchanged files', () => {
  it('keeps the count when only Calibre last_modified changes, and stores the file identity', async () => {
    const t = await setup([{ title: 'Book', epub: Buffer.from('12') }]);
    await t.poll();
    const first = getCountRecord(t.e.db, t.bookId('Book'))!;
    expect(first).toMatchObject({ status: 'ok', characters: 12 });
    expect(first.fileBytes).toBe(2);
    expect(first.fileMtimeNs).toMatch(/^\d+$/);

    // With the pass held back, the new Calibre key makes the count look out of date.
    const config = (t.e.counts as unknown as { opts: { config: { background: boolean } } }).opts
      .config;
    config.background = false;
    touchMetadata(t.lib, t.ids.get('Book')!);
    await t.e.indexer.tick();
    expect(t.e.counts.pending(10)).toHaveLength(1);
    expect((await t.status('Book')).charCountStatus).toBe('pending');
    config.background = true;
    const processed = t.e.counts.processed;
    await t.poll();

    const after = getCountRecord(t.e.db, t.bookId('Book'))!;
    expect(after.countedAt).toBe(first.countedAt);
    expect(after.characters).toBe(12);
    expect(after.sourceKey).not.toBe(first.sourceKey);
    expect(t.e.counts.processed).toBe(processed + 1);
    expect(t.e.counts.pending(10)).toHaveLength(0);
    expect(await t.status('Book')).toMatchObject({ charCount: 12, charCountStatus: 'counted' });
    expect(t.e.logs.some((l) => /1 unchanged files kept their count/.test(l))).toBe(true);
  });

  it('counts again when the EPUB is replaced, even with the same size', async () => {
    const t = await setup([{ title: 'Book', epub: Buffer.from('12') }]);
    await t.poll();
    const first = getCountRecord(t.e.db, t.bookId('Book'))!;
    await new Promise((r) => setTimeout(r, 20));
    t.lib.replaceEpub(t.ids.get('Book')!, Buffer.from('45'));
    t.lib.age();
    await t.poll();
    const after = getCountRecord(t.e.db, t.bookId('Book'))!;
    expect(after.characters).toBe(45);
    expect(after.countedAt).toBeGreaterThan(first.countedAt);
    expect(after.fileBytes).toBe(2);
    expect(after.fileMtimeNs).not.toBe(first.fileMtimeNs);
  });

  it('keeps the count when Calibre moves the book folder (title or author change)', async () => {
    const t = await setup([{ title: 'Book', epub: Buffer.from('77') }]);
    await t.poll();
    const first = getCountRecord(t.e.db, t.bookId('Book'))!;
    const calibreId = t.ids.get('Book')!;
    const oldDir = t.lib.bookDir(calibreId);
    const newRel = `Author ${calibreId}/Renamed (${calibreId})`;
    // Windows can refuse a rename for a moment while something (a virus scan) reads the
    // just-written files: try again briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(oldDir, path.join(t.lib.dir, newRel));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    t.lib.exec((db) =>
      db
        .prepare('UPDATE books SET path = ?, title = ?, last_modified = ? WHERE id = ?')
        .run(newRel, 'Renamed', calibreDate(new Date(Date.now() + 5000)), calibreId),
    );
    t.lib.age();
    await t.poll();
    const id = t.bookId('Renamed');
    const after = getCountRecord(t.e.db, id)!;
    expect(after.countedAt).toBe(first.countedAt);
    expect(after.characters).toBe(77);
    expect(after.sourceKey).toContain('Renamed');
    expect((await t.status('Renamed')).charCountStatus).toBe('counted');
  });

  it('keeps counts made before migration 17 only for files older than the count', async () => {
    const t = await setup([
      { title: 'Old file', epub: Buffer.from('10') },
      { title: 'Newer file', epub: Buffer.from('20') },
    ]);
    await t.poll();
    // As if counted before migration 17: no stored identity. "Newer file" was counted
    // before its file was last written.
    t.e.db.prepare('UPDATE char_counts SET file_bytes = NULL, file_mtime_ns = NULL').run();
    t.e.db
      .prepare('UPDATE char_counts SET counted_at = 1000 WHERE book_id = ?')
      .run(t.bookId('Newer file'));
    const old = getCountRecord(t.e.db, t.bookId('Old file'))!;
    touchMetadata(t.lib, t.ids.get('Old file')!);
    touchMetadata(t.lib, t.ids.get('Newer file')!);
    await t.poll();
    const kept = getCountRecord(t.e.db, t.bookId('Old file'))!;
    expect(kept.countedAt).toBe(old.countedAt);
    expect(kept.fileBytes).toBe(2);
    const recounted = getCountRecord(t.e.db, t.bookId('Newer file'))!;
    expect(recounted.countedAt).toBeGreaterThan(1000);
    expect(recounted.characters).toBe(20);
  });

  it('keeps a failure (no retry) when only last_modified changes', async () => {
    const t = await setup([{ title: 'Broken', epub: Buffer.from('BAD') }]);
    await t.poll();
    const first = getCountRecord(t.e.db, t.bookId('Broken'))!;
    expect(first).toMatchObject({ status: 'error', attempts: 1 });
    touchMetadata(t.lib, t.ids.get('Broken')!);
    await t.poll();
    const after = getCountRecord(t.e.db, t.bookId('Broken'))!;
    expect(after).toMatchObject({ status: 'error', attempts: 1, countedAt: first.countedAt });
    expect((await t.status('Broken')).charCountStatus).toBe('error');
  });
});

describe('thumbnails keep unchanged covers', () => {
  it('keeps a thumbnail when only last_modified changes, and remakes it for a new cover', async () => {
    const t = await setup([{ title: 'Covered', coverHue: 30, epub: Buffer.from('5') }]);
    await t.e.indexer.tick();
    const id = t.bookId('Covered');
    const made = (await t.e.thumbnails.ensure(id))!;
    expect(made.record.coverBytes).toBeGreaterThan(0);
    const bytes = fs.readFileSync(made.file!);

    touchMetadata(t.lib, t.ids.get('Covered')!);
    await t.e.indexer.tick();
    expect(t.e.thumbnails.pending(10).map((p) => p.bookId)).toEqual([id]);
    // The background pass keeps it without making it again.
    (t.e.thumbnails as unknown as { opts: { background: boolean } }).opts.background = true;
    t.e.thumbnails.wake();
    await t.e.thumbnails.idle();
    const kept = getThumbnailRecord(t.e.db, id)!;
    expect(kept.generatedAt).toBe(made.record.generatedAt);
    expect(kept.sourceKey).not.toBe(made.record.sourceKey);
    expect(t.e.thumbnails.pending(10)).toEqual([]);
    expect(fs.readFileSync(made.file!).equals(bytes)).toBe(true);
    expect(t.e.logs.some((l) => /1 unchanged covers kept their thumbnail/.test(l))).toBe(true);

    // A new cover (Calibre writes cover.jpg and bumps last_modified): made again.
    await new Promise((r) => setTimeout(r, 20));
    await t.lib.setCover(t.ids.get('Covered')!, 200);
    t.lib.age();
    await t.e.indexer.tick();
    const remade = (await t.e.thumbnails.ensure(id))!;
    expect(remade.record.generatedAt).toBeGreaterThan(made.record.generatedAt);
    expect(fs.readFileSync(remade.file!).equals(bytes)).toBe(false);
  });

  it('on request too: an unchanged cover is kept, one made before migration 17 only if older', async () => {
    const t = await setup([
      { title: 'A', coverHue: 10 },
      { title: 'B', coverHue: 90 },
    ]);
    await t.e.indexer.tick();
    const a = (await t.e.thumbnails.ensure(t.bookId('A')))!;
    await t.e.thumbnails.ensure(t.bookId('B'));
    t.e.db.prepare('UPDATE thumbnails SET cover_bytes = NULL, cover_mtime_ns = NULL').run();
    t.e.db
      .prepare('UPDATE thumbnails SET generated_at = 1000 WHERE book_id = ?')
      .run(t.bookId('B'));
    touchMetadata(t.lib, t.ids.get('A')!);
    touchMetadata(t.lib, t.ids.get('B')!);
    await t.e.indexer.tick();
    const keptA = (await t.e.thumbnails.ensure(t.bookId('A')))!;
    expect(keptA.record.generatedAt).toBe(a.record.generatedAt);
    expect(keptA.record.coverMtimeNs).toMatch(/^\d+$/);
    const remadeB = (await t.e.thumbnails.ensure(t.bookId('B')))!;
    expect(remadeB.record.generatedAt).toBeGreaterThan(1000);
  });
});

describe('file identity', () => {
  it('compares size and modified time, or the time against when a result was made', async () => {
    const dir = makeTempDir('ident');
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, 'abc');
    const id = (await fileIdentity(file))!;
    expect(id.bytes).toBe(3);
    expect(await fileIdentity(path.join(dir, 'missing'))).toBeNull();
    expect(await fileIdentity(dir)).toBeNull();
    expect(sameFile(id, { bytes: 3, mtimeNs: id.mtimeNs }, 0)).toBe(true);
    expect(sameFile(id, { bytes: 4, mtimeNs: id.mtimeNs }, 0)).toBe(false);
    expect(sameFile(id, { bytes: 3, mtimeNs: '1' }, 0)).toBe(false);
    expect(sameFile(id, { bytes: null, mtimeNs: null }, id.mtimeMs + 1)).toBe(true);
    expect(sameFile(id, { bytes: null, mtimeNs: null }, id.mtimeMs - 1)).toBe(false);
  });

  it('migration 17 adds empty identity columns and keeps existing rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((m) => m.version <= 16)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare(
      `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
       VALUES ('l', 'f', 'L', 'ja', 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
       VALUES ('b', 'l', 'T', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
       VALUES ('b', 'ok', 'k', 'v1|Off|anchor', 5, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO thumbnails (book_id, status, source_key, spec, attempts, generated_at)
       VALUES ('b', 'ok', 'k', 1, 0, 1)`,
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db.prepare('SELECT characters, file_bytes, file_mtime_ns FROM char_counts').get(),
    ).toEqual({ characters: 5, file_bytes: null, file_mtime_ns: null });
    expect(db.prepare('SELECT cover_bytes, cover_mtime_ns FROM thumbnails').get()).toEqual({
      cover_bytes: null,
      cover_mtime_ns: null,
    });
    db.close();
  });
});
