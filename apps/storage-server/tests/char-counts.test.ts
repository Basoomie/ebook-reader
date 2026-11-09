/**
 * Character counts (WP3b): the background pass, its records and the catalog API.
 * Real counts use the committed counter bundle on the web app's synthetic EPUBs,
 * whose expected values were captured from the browser import. Failure handling
 * uses a stand-in counter (same protocol, behaviour chosen by the file contents).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { readCounterInfo } from '../src/counts/counter-bundle';
import { CharCountService } from '../src/counts/count-service';
import { forgetCounts, getCountRecord } from '../src/counts/count-records';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { CalibreRoot, fingerprint, FixtureBook, LibraryFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import type { CountsConfig } from '../src/config';

const WEB_FIXTURES = path.resolve(__dirname, '..', '..', 'web', 'tests', 'fixtures');
const expected = JSON.parse(
  fs.readFileSync(path.join(WEB_FIXTURES, 'synthetic.expected.json'), 'utf8'),
) as { books: Record<string, Record<string, { characters?: number; error?: string }>> };

function webEpub(name: string): Buffer {
  return fs.readFileSync(path.join(WEB_FIXTURES, name));
}

function expectedCount(name: string, mode = 'Off|restrictToAnchor=true'): number {
  return expected.books[name][mode].characters!;
}

/**
 * A stand-in for vendor/epub-count.cjs (it loads in milliseconds, unlike jsdom).
 * The EPUB's contents choose what happens: a number is the count (plus 1000 with
 * the Extended import fix, to show the settings reach the counter), HANG never
 * answers, CRASH exits, BAD throws.
 */
function fakeCounter(version = 1, reportedVersion = version): string {
  const file = path.join(makeTempDir('counter'), 'fake-count.cjs');
  fs.writeFileSync(
    file,
    `/*
 * epub-count-version: ${version}
 * build: 00000000fa4ec0de
 */
exports.EPUB_COUNT_VERSION = ${reportedVersion};
exports.countEpubForServer = async (blob, options) => {
  const text = Buffer.from(await blob.slice(0, 32).arrayBuffer()).toString('utf8').trim();
  if (text === 'HANG') return new Promise(() => {});
  if (text === 'CRASH') process.exit(3);
  if (text === 'BAD') throw new Error('not an EPUB');
  return { characters: Number(text) + (options.importHTMLFixMode === 'Extended' ? 1000 : 0) };
};
`,
  );
  return file;
}

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

interface Setup {
  e: IndexerEnv;
  root: CalibreRoot;
  lib: LibraryFixture;
  libId: string;
  ids: Map<string, number>;
}

async function indexed(
  books: FixtureBook[],
  counts: Partial<CountsConfig> = {},
  counterFile?: string,
): Promise<Setup> {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const ids = new Map<string, number>();
  for (const book of books) ids.set(book.title, await lib.addBook({ cover: 'none', ...book }));
  const e = makeIndexerEnv(
    root.dir,
    {},
    {},
    { config: { background: true, timeoutSeconds: 60, ...counts }, counterFile },
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  return { e, root, lib, libId, ids };
}

/** One indexer poll (which wakes the counter) and the whole counting pass. */
async function poll(e: IndexerEnv): Promise<void> {
  await e.indexer.tick();
  await e.counts.idle();
}

function bookId(e: IndexerEnv, title: string): string {
  return (e.db.prepare('SELECT id FROM books WHERE title = ?').get(title) as { id: string }).id;
}

async function apiBook(e: IndexerEnv, title: string) {
  const res = await request(e.app)
    .get(`/api/v1/books/${bookId(e, title)}`)
    .set('Authorization', `Bearer ${e.token()}`);
  expect(res.status).toBe(200);
  return res.body as { charCount: number | null; charCountStatus: string };
}

describe('character counts', () => {
  it("counts each EPUB with the reader's rules, reads no images and never writes to Calibre", async () => {
    const names = [
      'synthetic-epub3.epub',
      'synthetic-epub2-ncx.epub',
      'synthetic-epub3-navonly.epub',
    ];
    const { e, root, libId } = await indexed(
      names.map((name) => ({ title: name, epub: webEpub(name) })),
      { background: false },
    );
    await poll(e);
    const before = fingerprint(root.dir);

    // Indexed, not counted yet.
    for (const name of names) {
      expect(await apiBook(e, name)).toMatchObject({ charCount: null, charCountStatus: 'pending' });
    }
    const libs = await request(e.app)
      .get('/api/v1/libraries')
      .set('Authorization', `Bearer ${e.token()}`);
    expect(libs.body.libraries.find((l: { id: string }) => l.id === libId).counts).toEqual({
      counted: 0,
      pending: 3,
      errors: 0,
    });

    (e.counts as unknown as { opts: { config: CountsConfig } }).opts.config.background = true;
    await poll(e);

    for (const name of names) {
      expect(await apiBook(e, name)).toEqual(
        expect.objectContaining({ charCount: expectedCount(name), charCountStatus: 'counted' }),
      );
      const record = getCountRecord(e.db, bookId(e, name))!;
      expect(record).toMatchObject({ status: 'ok', spec: 'v1|Off|anchor', attempts: 0 });
      expect(record.build).toBe(readCounterInfo().build);
      // Only the ZIP directory and the text entries are read, never the whole file.
      expect(record.bytesRead).toBeGreaterThan(0);
      expect(record.bytesRead).toBeLessThan(webEpub(name).length);
    }
    const list = await request(e.app)
      .get('/api/v1/books')
      .set('Authorization', `Bearer ${e.token()}`);
    expect(list.body.books.map((b: { charCountStatus: string }) => b.charCountStatus)).toEqual([
      'counted',
      'counted',
      'counted',
    ]);
    const after = await request(e.app)
      .get('/api/v1/libraries')
      .set('Authorization', `Bearer ${e.token()}`);
    expect(after.body.libraries.find((l: { id: string }) => l.id === libId).counts).toEqual({
      counted: 3,
      pending: 0,
      errors: 0,
    });
    expect(fingerprint(root.dir)).toEqual(before);

    // Nothing to do on the next poll.
    const processed = e.counts.processed;
    await poll(e);
    expect(e.counts.processed).toBe(processed);
  }, 120_000);

  it('counts again when the EPUB changes (keeping the old count meanwhile) or the spec changes', async () => {
    const { e, root, lib, ids } = await indexed(
      [{ title: 'Book', epub: Buffer.from('12') }],
      {},
      fakeCounter(),
    );
    const setBackground = (on: boolean) => {
      (e.counts as unknown as { opts: { config: CountsConfig } }).opts.config.background = on;
    };
    await poll(e);
    expect(await apiBook(e, 'Book')).toMatchObject({ charCount: 12, charCountStatus: 'counted' });

    // Calibre replaces the EPUB; until the pass runs the old count is shown as pending.
    lib.replaceEpub(ids.get('Book')!, Buffer.from('345'));
    lib.age();
    setBackground(false);
    await poll(e);
    expect(await apiBook(e, 'Book')).toMatchObject({ charCount: 12, charCountStatus: 'pending' });
    setBackground(true);
    await poll(e);
    expect(await apiBook(e, 'Book')).toMatchObject({ charCount: 345, charCountStatus: 'counted' });

    // Other import settings: a new spec, so the book is counted again with them.
    const extended = new CharCountService({
      db: e.db,
      calibreDir: root.dir,
      config: { ...e.counts['opts'].config, background: true, importFixMode: 'Extended' },
      counterFile: e.counts.counter.file,
      log: () => {},
    });
    try {
      expect(extended.spec).toBe('v1|Extended|anchor');
      expect(extended.pending(10).map((b) => b.bookId)).toEqual([bookId(e, 'Book')]);
      extended.wake();
      await extended.idle();
    } finally {
      await extended.stop();
    }
    expect(getCountRecord(e.db, bookId(e, 'Book'))).toMatchObject({
      spec: 'v1|Extended|anchor',
      characters: 1345,
    });
    // A server still configured with the old settings sees that count as out of date.
    expect((await apiBook(e, 'Book')).charCountStatus).toBe('pending');
  });

  it('records failures, keeps them until the source changes or a retry, and blames each book only', async () => {
    const counter = fakeCounter();
    const { e, lib, ids } = await indexed(
      [
        { title: 'Good', epub: Buffer.from('12') },
        { title: 'Bad', epub: Buffer.from('BAD') },
        { title: 'Gone', epub: Buffer.from('3') },
      ],
      {},
      counter,
    );
    fs.unlinkSync(lib.epubFile(ids.get('Gone')!));
    await poll(e);

    expect(await apiBook(e, 'Good')).toMatchObject({ charCount: 12, charCountStatus: 'counted' });
    expect(await apiBook(e, 'Bad')).toMatchObject({ charCount: null, charCountStatus: 'error' });
    expect(getCountRecord(e.db, bookId(e, 'Bad'))).toMatchObject({
      status: 'error',
      errorCode: 'bad_epub',
      error: 'not an EPUB',
      attempts: 1,
    });
    expect(getCountRecord(e.db, bookId(e, 'Gone'))).toMatchObject({
      errorCode: 'file_missing',
      attempts: 1,
    });

    // Not tried again on the next poll.
    const processed = e.counts.processed;
    await poll(e);
    expect(e.counts.processed).toBe(processed);

    // `cli counts retry` forgets the failures: tried again (and still failing).
    expect(forgetCounts(e.db, { errors: true })).toBe(2);
    await poll(e);
    expect(e.counts.processed).toBe(processed + 2);

    // The user fixes the book in Calibre: counted.
    lib.replaceEpub(ids.get('Bad')!, Buffer.from('77'));
    lib.age();
    await poll(e);
    expect(await apiBook(e, 'Bad')).toMatchObject({ charCount: 77, charCountStatus: 'counted' });
  });

  it('replaces a counter that hangs or crashes and carries on with the next book', async () => {
    const { e } = await indexed(
      [
        { title: 'Hang', epub: Buffer.from('HANG') },
        { title: 'Crash', epub: Buffer.from('CRASH') },
        { title: 'Fine', epub: Buffer.from('5') },
      ],
      { timeoutSeconds: 3 },
      fakeCounter(),
    );
    await poll(e);
    expect(getCountRecord(e.db, bookId(e, 'Hang'))).toMatchObject({
      errorCode: 'timeout',
      error: 'no result after 3 s',
    });
    expect(getCountRecord(e.db, bookId(e, 'Crash'))).toMatchObject({ errorCode: 'crashed' });
    expect(getCountRecord(e.db, bookId(e, 'Crash'))!.error).toContain('code 3');
    expect(await apiBook(e, 'Fine')).toMatchObject({ charCount: 5, charCountStatus: 'counted' });
  });

  it('pauses after too many crashes in a row instead of marking every book', async () => {
    const { e } = await indexed(
      [1, 2, 3, 4].map((n) => ({ title: `Crash ${n}`, epub: Buffer.from('CRASH') })),
      { maxConsecutiveFailures: 2 },
      fakeCounter(),
    );
    await poll(e);
    const failed = e.db.prepare("SELECT COUNT(*) AS n FROM char_counts WHERE status = 'error'");
    expect((failed.get() as { n: number }).n).toBe(2);
    expect(e.logs.filter((l) => l.includes('counting paused'))).toHaveLength(1);
  });

  it('blames no book when the counter cannot start, and reports it once', async () => {
    const { e } = await indexed([{ title: 'Book', epub: Buffer.from('1') }], {}, fakeCounter(1, 2));
    await poll(e);
    await poll(e);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM char_counts').get()).toEqual({ n: 0 });
    const reports = e.logs.filter((l) => l.includes('the counter cannot start'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('reports version 2 but its header says 1');
    expect(await apiBook(e, 'Book')).toMatchObject({ charCountStatus: 'pending' });
  });

  it('stops a count in progress without recording it', async () => {
    const { e } = await indexed([{ title: 'Hang', epub: Buffer.from('HANG') }], {}, fakeCounter());
    await e.indexer.tick();
    await new Promise((r) => setTimeout(r, 2000));
    const started = Date.now();
    await e.counts.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM char_counts').get()).toEqual({ n: 0 });
  });
});

describe('migration 6', () => {
  it('adds char_counts to a version-5 database and keeps the books', () => {
    const file = path.join(makeTempDir('db'), 'ttsu.db');
    const db = new Database(file);
    for (const m of MIGRATIONS.filter((m) => m.version <= 5)) db.exec(m.sql);
    db.pragma('user_version = 5');
    db.prepare(
      "INSERT INTO libraries (id, folder, name, enabled, available, discovered_at, updated_at) VALUES ('l', 'a', 'A', 0, 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO books (id, library_id, title, added_at, created_at, updated_at) VALUES ('b', 'l', 'T', 1, 1, 1)",
    ).run();
    expect(migrate(db)).toBe(6);
    expect(db.prepare('SELECT id, char_count FROM books').all()).toEqual([
      { id: 'b', char_count: null },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM char_counts').get()).toEqual({ n: 0 });
    db.close();
  });
});
