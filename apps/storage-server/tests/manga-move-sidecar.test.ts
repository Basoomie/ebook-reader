/**
 * Manga part A: the real apply sidecar (1.6.0) against the real server, moving books between two
 * libraries of the stand-in calibredb (fake-calibredb.cjs with FAKE_LIBRARIES): export, the add
 * carrying every field (as real calibre 9.18's add of an export does: the probe of 2026-11-24),
 * the fields that didn't arrive written again, the server's check, the removal, the reader keeping
 * its book, Undo carrying a later change back, and a timed-out add that is never repeated.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb } from '../../cleanup-apply/src/calibredb';
import { CalibredbHelper } from '../../cleanup-apply/src/calibredb-helper';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { differingFields, fieldArgsFrom } from '../../cleanup-apply/src/move';
import { Worker } from '../../cleanup-apply/src/worker';
import { listLibraries, updateLibrary } from '../src/calibre/libraries';
import { BatchError } from '../src/cleanup/batches';
import { findCalibreSource } from '../src/cleanup/handoff';
import { getMoveState, saveMoveProgress } from '../src/cleanup/move/state';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import type { LibraryFixture } from './helpers/calibre-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { addStage2Tables, setStage2Fields } from './helpers/stage2-fixture';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const FAKE_HELPER = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb-helper.cjs');
const PASSWORD = 'calibre-test-password';
const quiet = { info: () => {}, error: () => {} };
const helpers: CalibredbHelper[] = [];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (fill: string, n = 4096) => Buffer.alloc(n, fill);

/** #characters like the NAS's (an int column), beside stage 2's tables (#illustrator, names). */
function addMoveColumns(lib: LibraryFixture) {
  addStage2Tables(lib);
  const db = new Database(path.join(lib.dir, 'metadata.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_column_2 ( id INTEGER PRIMARY KEY AUTOINCREMENT,
      book INTEGER, value INT NOT NULL, UNIQUE(book));
    INSERT OR IGNORE INTO custom_columns (id, label, name, datatype, is_multiple, normalized, display)
      VALUES (2, 'characters', 'Characters', 'int', 0, 0, '{"number_format": null}');
  `);
  db.close();
}

describe('pure parts of the sidecar move', () => {
  it('compares a listed book field by field, as calibredb lists them', () => {
    const a = {
      title: 'T',
      authors: 'A & B',
      series: 'S',
      series_index: 1.5,
      tags: ['マンガ', 'x'],
      identifiers: { isbn: '1', amazon_jp: 'B0' },
      timestamp: '2020-01-02T03:04:05.123+00:00',
      '*characters': 12,
      cover: 1,
      formats: ['EPUB'],
    };
    expect(
      differingFields(a, {
        ...a,
        tags: ['X', 'マンガ'],
        identifiers: { amazon_jp: 'B0', isbn: '1' },
        timestamp: '2020-01-02T03:04:05+00:00',
      }),
    ).toEqual([]);
    expect(differingFields(a, { ...a, series: undefined, '*characters': undefined })).toEqual([
      'series',
      'series_index',
      '*characters',
    ]);
    // Without a series, the number Calibre keeps (1.0) is not a difference.
    expect(
      differingFields({ title: 'x', series_index: 1 }, { title: 'x', series_index: 3 }),
    ).toEqual([]);
    expect(
      fieldArgsFrom(
        ['series', 'rating', '*illustrator', '*characters', 'timestamp'],
        {
          series: 'S',
          series_index: 2,
          rating: 8,
          '*illustrator': ['甲', '乙'],
          '*characters': 0,
          timestamp: '2020-01-02T03:04:05+00:00',
        },
        true,
        null,
      ),
    ).toEqual([
      'series:S',
      'series_index:2',
      'rating:4',
      'timestamp:2020-01-02T03:04:05+00:00',
      '#illustrator:甲 & 乙',
      '#characters:0',
    ]);
  });
});

describe('the sidecar moves books', () => {
  let env: CleanupEnv;
  let manga: LibraryFixture;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let apply: string;
  let user: string;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  let books: Record<string, string>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const listen = (s: http.Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );
  const mangaId = () => listLibraries(env.db).find((l) => l.folder === 'manga-library')!.id;
  const indexAll = async () => {
    await env.index();
    manga.age();
    await env.indexer.checkLibrary(listLibraries(env.db).find((l) => l.id === mangaId())!);
  };
  const row = (lib: LibraryFixture, sql: string, ...p: unknown[]) => {
    const db = new Database(path.join(lib.dir, 'metadata.db'), { readonly: true });
    try {
      return db.prepare(sql).get(...p) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addMoveColumns(env.lib);
    const epubA = bytes('a');
    ids = {
      A: await env.lib.addBook({
        title: 'よつばと!(1)',
        sort: 'よつばと!(1) sort',
        authors: ['あずまきよひこ'],
        authorSort: 'アズマ キヨヒコ',
        series: { name: 'よつばと!', index: 1 },
        tags: ['マンガ', 'TMW-collection-2'],
        publisher: 'KADOKAWA',
        comments: '<p>一行目</p>',
        pubdate: '2003-08-27 00:00:00+00:00',
        timestamp: '2020-01-02 03:04:05+00:00',
        epub: epubA,
      }),
      B: await env.lib.addBook({
        title: '画集',
        authors: ['画家'],
        tags: ['画像のみ'],
        epub: bytes('b'),
      }),
      P: await env.lib.addBook({ title: '小説', authors: ['作家'], epub: bytes('p') }),
    };
    setStage2Fields(env.lib, ids.A, {
      identifiers: { isbn: '9784840227414', amazon_jp: 'B00AAAAAAA' },
      languages: ['jpn'],
      illustrators: ['画家甲', '画家乙'],
    });
    env.lib.exec((db) => {
      db.prepare('INSERT INTO ratings (rating) VALUES (8)').run();
      db.prepare(
        'INSERT INTO books_ratings_link (book, rating) VALUES (?, (SELECT id FROM ratings WHERE rating = 8))',
      ).run(ids.A);
      db.prepare('INSERT INTO custom_column_2 (book, value) VALUES (?, 1234)').run(ids.A);
    });
    await made.setup();
    manga = env.root.library('manga-library');
    addMoveColumns(manga);
    await env.indexer.discover();
    updateLibrary(env.db, mangaId(), { language: 'ja', enabled: true });
    await indexAll();
    const lib = env.libraryId();
    uuids = {};
    books = {};
    for (const [k, id] of Object.entries(ids)) {
      uuids[k] = row(env.lib, 'SELECT uuid FROM books WHERE id = ?', id)!.uuid as string;
      books[k] = findCalibreSource(env.db, lib, uuids[k])!.bookId;
      const size = row(
        env.lib,
        `SELECT uncompressed_size AS n FROM data WHERE book = ? AND format = 'EPUB'`,
        id,
      )!.n as number;
      env.db
        .prepare(
          `INSERT INTO char_counts (book_id, status, source_key, spec, characters, attempts, counted_at, file_bytes)
           VALUES (?, 'ok', 'k', 'v1', 100, 0, ?, ?)`,
        )
        .run(books[k], Date.now(), size);
    }
    env.addReaderData(books.A);
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    (env as unknown as { url: string }).url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    user = env.userToken();
    apply = env.applyToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        // 10 % of three books: one book per batch (two move batches, each taken in first).
        pacing: { itemDelaySeconds: 0, batchSize: 500, maxBatchPercent: 10 },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
  });

  afterEach(async () => {
    for (const h of helpers.splice(0)) h.stop();
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker(
    extra: {
      drop?: string;
      addTimeout?: 'after';
      helper?: boolean;
      logs?: string[];
      fail?: string;
    } = {},
  ) {
    const config: SidecarConfig = {
      serverUrl: (env as unknown as { url: string }).url,
      token: apply,
      quarantineDir: quarantine,
      calibredb: process.execPath,
      minFreeMb: 1,
      calibredbTimeoutSeconds: 60,
      checkSeconds: 3600,
      requestTimeoutSeconds: 10,
      trashRestoreWaitSeconds: 3,
      removeWaitSeconds: 3,
      waitPollSeconds: 0.1,
    } as SidecarConfig;
    const fakeEnv = {
      FAKE_LIBRARIES: JSON.stringify({
        'japanese-library': env.lib.dir,
        'manga-library': manga.dir,
      }),
      FAKE_PASSWORD: PASSWORD,
      FAKE_ILLUSTRATOR: '1',
      FAKE_COLUMNS_FROM_DB: '1',
      FAKE_ADD_FULL: '1',
      FAKE_ADD_DROP: extra.drop ?? '',
      FAKE_ADD_TIMEOUT: extra.addTimeout ?? '',
      FAKE_FAIL: extra.fail ?? '',
    };
    let helper: CalibredbHelper | null = null;
    if (extra.helper !== false) {
      helper = new CalibredbHelper({
        program: process.execPath,
        args: [FAKE_HELPER],
        startTimeoutMs: 10_000,
        env: fakeEnv,
      });
      helpers.push(helper);
    }
    const logs = extra.logs;
    return new Worker({
      config,
      calibredb: new Calibredb({
        program: process.execPath,
        prefixArgs: [FAKE],
        timeoutMs: 60_000,
        env: fakeEnv,
        helper,
      }),
      log: logs ? { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) } : quiet,
      retryMinMs: 20,
      retryMaxMs: 100,
    });
  }

  async function preview() {
    env.service.move.setMode('analyse');
    for (let i = 0; i < 10; i++) if ((await env.service.move.step()) !== 'more') break;
    for (const b of env.service.move.spotList()) env.service.move.setVerdict(b.uuid, 'right');
    env.service.move.setMode('on');
  }

  async function runAll(w: Worker, rounds = 24) {
    for (let i = 0; i < rounds; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
      const r = await w.cycle();
      await indexAll();
      await env.service.tick();
      if (
        r === 'idle' &&
        !env.service.batches.open() &&
        getMoveState(env.cleanupDb).progress.phase === 'done'
      )
        return;
    }
  }

  const fieldsOf = (lib: LibraryFixture, id: number) => ({
    book: row(
      lib,
      'SELECT title, sort, author_sort, series_index, pubdate, timestamp, has_cover FROM books WHERE id = ?',
      id,
    ),
    series: row(
      lib,
      'SELECT s.name FROM books_series_link l JOIN series s ON s.id = l.series WHERE l.book = ?',
      id,
    ),
    rating: row(
      lib,
      'SELECT r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating WHERE l.book = ?',
      id,
    ),
    chars: row(lib, 'SELECT value FROM custom_column_2 WHERE book = ?', id),
    illustrators: (() => {
      const db = new Database(path.join(lib.dir, 'metadata.db'), { readonly: true });
      const r = db
        .prepare(
          'SELECT v.value FROM books_custom_column_1_link l JOIN custom_column_1 v ON v.id = l.value WHERE l.book = ? ORDER BY l.id',
        )
        .all(id)
        .map((x) => (x as { value: string }).value);
      db.close();
      return r;
    })(),
    publisher: row(
      lib,
      'SELECT p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher WHERE l.book = ?',
      id,
    ),
  });

  it('moves every field, keeps the reader book, and Undo carries a later change back', async () => {
    const before = fieldsOf(env.lib, ids.A);
    await preview();
    const logs: string[] = [];
    const w = worker({ logs });
    await runAll(w);
    const moves = env.cleanupDb
      .prepare('SELECT * FROM calibre_moves ORDER BY from_calibre_id')
      .all() as {
      from_calibre_id: number;
      to_calibre_id: number;
      to_uuid: string;
      state: string;
    }[];
    expect(moves.map((m) => [m.from_calibre_id, m.state])).toEqual([
      [ids.A, 'moved'],
      [ids.B, 'moved'],
    ]);
    const a = moves[0];
    // Every field arrived, and the old copy is in Calibre's trash.
    expect(fieldsOf(manga, a.to_calibre_id)).toEqual(before);
    expect(row(env.lib, 'SELECT id FROM books WHERE id = ?', ids.A)).toBeUndefined();
    expect(fs.existsSync(path.join(env.lib.dir, '.caltrash', 'b', String(ids.A)))).toBe(true);
    expect(row(env.lib, 'SELECT id FROM books WHERE id = ?', ids.P)).toBeDefined();
    // The same reader book, now in the manga library, with its data and no "yours" fields.
    expect(findCalibreSource(env.db, mangaId(), a.to_uuid)?.bookId).toBe(books.A);
    expect(findCalibreSource(env.db, mangaId(), a.to_uuid)?.missingAt).toBeNull();
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM calibre_field_changes').get()).toEqual({
      n: 0,
    });
    // The quarantine keeps the export with the EPUB's bytes.
    const batch = (
      env.cleanupDb.prepare(`SELECT id FROM batches WHERE stage = 11 AND kind = 'apply'`).get() as {
        id: string;
      }
    ).id;
    const exported = fs.readdirSync(path.join(quarantine, batch));
    expect(exported).toContain('metadata.db');
    expect(exported).toContain(`${ids.A}.json`);
    expect(exported).toContain(`${ids.A}.add.json`);
    const epub = fs.readFileSync(path.join(quarantine, batch, String(ids.A), 'book.epub'));
    expect(sha(epub)).toBe(sha(bytes('a')));
    expect(logs.some((l) => /Moved \d+ to manga-library as \d+/.test(l))).toBe(true);

    // A change in the manga library after the move, then Undo.
    manga.exec((db) => {
      db.prepare('DELETE FROM books_publishers_link WHERE book = ?').run(a.to_calibre_id);
      db.prepare(`INSERT OR IGNORE INTO publishers (name) VALUES ('講談社')`).run();
      db.prepare(
        `INSERT INTO books_publishers_link (book, publisher) VALUES (?, (SELECT id FROM publishers WHERE name = '講談社'))`,
      ).run(a.to_calibre_id);
    });
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    expect(row(env.lib, 'SELECT uuid FROM books WHERE id = ?', ids.A)?.uuid).toBe(uuids.A);
    expect(fieldsOf(env.lib, ids.A).publisher).toEqual({ name: '講談社' });
    expect(row(manga, 'SELECT id FROM books WHERE id = ?', a.to_calibre_id)).toBeUndefined();
    expect(findCalibreSource(env.db, env.libraryId(), uuids.A)?.bookId).toBe(books.A);
    expect(findCalibreSource(env.db, env.libraryId(), uuids.A)?.missingAt).toBeNull();
    expect(
      (
        env.cleanupDb
          .prepare(`SELECT state FROM calibre_moves WHERE from_calibre_id = ?`)
          .get(ids.A) as { state: string }
      ).state,
    ).toBe('undone');
  });

  it('writes again the fields the add did not carry, and records them', async () => {
    const before = fieldsOf(env.lib, ids.A);
    await preview();
    const w = worker({ drop: 'series,*characters', helper: false });
    await runAll(w);
    const a = env.cleanupDb
      .prepare('SELECT to_calibre_id, fields_json FROM calibre_moves WHERE from_calibre_id = ?')
      .get(ids.A) as { to_calibre_id: number };
    expect(fieldsOf(manga, a.to_calibre_id)).toEqual(before);
    const note = env.cleanupDb
      .prepare(
        `SELECT i.move_json FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id WHERE c.calibre_id = ? AND c.stage = 11`,
      )
      .get(ids.A) as { move_json: string };
    expect(JSON.parse(note.move_json).fixed).toEqual(['series', 'series_index', '*characters']);
  });

  it('a move batch stops after books failed in a row; the books not reached go back', async () => {
    updateSettings(env.cleanupDb, {
      move: { ...getSettings(env.cleanupDb).move, stopAfterFailures: 1 },
    });
    // A batch holds at most 10 % of the library: 20 novels more make it two books.
    for (let i = 0; i < 20; i++)
      await env.lib.addBook({ title: `小説${i}`, authors: ['作家'], epub: bytes(String(i % 10)) });
    await indexAll();
    await preview();
    const logs: string[] = [];
    const w = worker({ fail: 'add', logs });
    await runAll(w);
    expect(row(manga, 'SELECT COUNT(*) AS n FROM books')!.n).toBe(0);
    const items = env.cleanupDb
      .prepare(`SELECT state, detail FROM batch_items ORDER BY position`)
      .all() as { state: string; detail: string | null }[];
    expect(items.map((i) => i.state)).toEqual(['failed', 'skipped']);
    expect(items[1].detail).toMatch(/Not finished/);
    expect(
      env.cleanupDb
        .prepare(
          `SELECT state FROM proposed_changes WHERE stage = 11 AND class = 'auto' ORDER BY id`,
        )
        .all(),
    ).toEqual([{ state: 'skipped' }, { state: 'proposed' }]);
    const st = getMoveState(env.cleanupDb);
    expect(st.pausedReason).toBe('batch_failed');
    expect(st.pausedDetail).toMatch(/1 books in a row failed, so the batch stopped/);
    expect(logs.some((l) => /in a row failed/.test(l))).toBe(true);
  });

  it('the server check is asked again when the server fails; a check that keeps failing takes the copy out', async () => {
    await preview();
    const moves = env.service.batches.moves;
    const real = moves.checkArrived.bind(moves);
    // The first book: the server fails once (a 500, as when it restarts), then answers. Every
    // other book: the check is refused for good (a 4xx), so its added copy goes out again.
    let first: number | null = null;
    let calls = 0;
    moves.checkArrived = async (...args: Parameters<typeof real>) => {
      first ??= args[1];
      if (args[1] !== first) throw new BatchError(409, 'bad_batch', 'Not a move batch');
      calls += 1;
      if (calls === 1) throw new Error('the server is restarting');
      return real(...args);
    };
    const w = worker();
    await runAll(w);
    expect(calls).toBeGreaterThanOrEqual(2);
    const states = env.cleanupDb
      .prepare(`SELECT state, detail FROM batch_items ORDER BY position`)
      .all() as { state: string; detail: string | null }[];
    expect(states[0].state).toBe('removed');
    const failed = states.filter((x) => x.state === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) expect(f.detail).toMatch(/was taken out again/);
    // Only the moved book is in the manga library: no copy left behind.
    expect(row(manga, 'SELECT COUNT(*) AS n FROM books')!.n).toBe(1);
  });

  it('a book whose old copy Calibre would not remove is finished with the copy it left (1.8.2), never added twice', async () => {
    await preview();
    // Live 2026-11-28: Calibre refused the remove ("database is locked") after the copy was in.
    const logs: string[] = [];
    await runAll(worker({ fail: 'remove', logs }), 4);
    const left = row(manga, 'SELECT id, uuid FROM books') as { id: number; uuid: string };
    expect(row(manga, 'SELECT COUNT(*) AS n FROM books')!.n).toBe(1);
    expect(row(env.lib, 'SELECT id FROM books WHERE id = ?', ids.A)).toBeDefined();
    const failed = env.cleanupDb
      .prepare(`SELECT state, detail FROM batch_items WHERE state = 'failed'`)
      .all() as { detail: string }[];
    expect(failed.length).toBe(1);
    expect(failed[0].detail).toMatch(/stays: the move's next round finishes with it/);
    expect(getMoveState(env.cleanupDb).pausedReason).toBe('batch_failed');

    // Resumed; the next round proposes the book again and uses the copy it left.
    env.service.move.resume();
    const p = getMoveState(env.cleanupDb).progress;
    saveMoveProgress(env.cleanupDb, { ...p, phase: 'done', snapshotMtimeMs: 1 });
    const logs2: string[] = [];
    await runAll(worker({ logs: logs2 }));
    expect(logs2.some((l) => l.includes(`using the copy ${left.id} an earlier batch left`))).toBe(
      true,
    );
    const moves = env.cleanupDb
      .prepare(
        `SELECT from_calibre_id, to_calibre_id, to_uuid, state FROM calibre_moves ORDER BY from_calibre_id`,
      )
      .all() as {
      from_calibre_id: number;
      to_calibre_id: number;
      to_uuid: string;
      state: string;
    }[];
    expect(moves.map((m) => [m.from_calibre_id, m.state])).toEqual([
      [ids.A, 'moved'],
      [ids.B, 'moved'],
    ]);
    expect([moves[0].to_calibre_id, moves[0].to_uuid]).toEqual([left.id, left.uuid]);
    // One copy of each book in manga-library; none left in japanese-library.
    expect(row(manga, 'SELECT COUNT(*) AS n FROM books')!.n).toBe(2);
    expect(row(env.lib, 'SELECT id FROM books WHERE id = ?', ids.A)).toBeUndefined();
    expect(findCalibreSource(env.db, mangaId(), left.uuid)?.bookId).toBe(books.A);
  });

  it('adds go through the long-lived helper (1.6.1), not a new calibredb each time', async () => {
    await preview();
    const log = path.join(quarantine, 'helper.log');
    process.env.FAKE_HELPER_LOG = log;
    try {
      const w = worker();
      await runAll(w);
    } finally {
      delete process.env.FAKE_HELPER_LOG;
    }
    expect(row(manga, 'SELECT COUNT(*) AS n FROM books')!.n).toBe(2);
    const calls = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    expect(calls.filter((c) => c.startsWith('add ')).length).toBe(2);
  });

  it('an add that times out while Calibre adds the book anyway is found, never added twice', async () => {
    await preview();
    const w = worker({ addTimeout: 'after', helper: false });
    await runAll(w);
    const n = row(manga, 'SELECT COUNT(*) AS n FROM books')!.n;
    expect(n).toBe(2);
    expect(
      (
        env.cleanupDb
          .prepare(`SELECT COUNT(*) AS n FROM calibre_moves WHERE state = 'moved'`)
          .get() as { n: number }
      ).n,
    ).toBe(2);
  });
});
