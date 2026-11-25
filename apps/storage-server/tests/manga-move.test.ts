/**
 * Manga part A: the move stage in the storage server (selection and holds, the spot check, the
 * move batch's steps, the reader keeping the same book, the cleanup's state following the book,
 * the index check, Undo) on two synthetic Calibre libraries. The sidecar's side is played by the
 * test through the HTTP API; the Calibre writes it would make through the content server are
 * simulated on the fixtures (the only place anything is written to a library).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLibraries, updateLibrary } from '../src/calibre/libraries';
import { MOVE_STAGE } from '../src/cleanup/field-stages';
import { findCalibreSource } from '../src/cleanup/handoff';
import { decideMove, drawSpot, type MoveCandidate } from '../src/cleanup/move/select';
import { CALIBRE_AI_STAGES, rekeyCleanupState } from '../src/cleanup/move/rekey';
import { getMoveState, moveArrivalsAnalysisId, setMoveMode } from '../src/cleanup/move/state';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import type { LibraryFixture } from './helpers/calibre-fixture';
import { type CleanupEnv, healthyHeartbeat, makeCleanupEnv } from './helpers/cleanup-env';
import { makeZip } from './helpers/epub-fixture';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (fill: string, n = 4096) => Buffer.alloc(n, fill);

/**
 * A small EPUB: its files deflated, or (`repack`) the same files stored, as Calibre's DeDRM packs a
 * book again on add (other bytes, the same files inside); `page` changes one page's picture.
 */
const mangaEpub = (opts: { repack?: boolean; page?: string } = {}) =>
  makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'OEBPS/content.opf', data: '<package><metadata/></package>', deflate: !opts.repack },
    { name: 'OEBPS/p1.jpg', data: bytes('1', 3000), deflate: !opts.repack },
    { name: 'OEBPS/p2.jpg', data: bytes(opts.page ?? '2', 3000), deflate: !opts.repack },
  ]);

function candidate(over: Partial<MoveCandidate> = {}): MoveCandidate {
  return {
    calibreId: 1,
    uuid: 'u1',
    title: 'よつばと!(1)',
    authors: ['あずまきよひこ'],
    lastModified: null,
    path: 'a/b (1)',
    epubPath: 'a/b (1)/b.epub',
    epubSize: 100,
    formats: ['EPUB'],
    tags: ['マンガ'],
    matched: ['マンガ'],
    series: null,
    ...over,
  };
}

describe('the move rules', () => {
  const reader = (chars: number | null, noCount: 'not_counted' | null = null) => ({
    sourceId: 's',
    bookId: 'b',
    chars,
    noCount,
    hasData: false,
  });

  it('moves image books, holds real text, no EPUB, no count and too-long names', () => {
    expect(decideMove(candidate(), reader(120), 5000).hold).toBeNull();
    expect(decideMove(candidate(), reader(4999), 5000).hold).toBeNull();
    const text = decideMove(candidate(), reader(5000), 5000);
    expect(text.hold).toBe('real_text');
    expect(text.detail).toBe('5,000 characters');
    expect(decideMove(candidate({ epubPath: null, formats: ['ZIP'] }), reader(0), 5000).hold).toBe(
      'no_epub',
    );
    expect(decideMove(candidate(), reader(null, 'not_counted'), 5000).hold).toBe('no_count');
    expect(decideMove(candidate(), null, 5000).hold).toBe('not_in_reader');
    expect(decideMove(candidate({ title: 'あ'.repeat(120) }), reader(10), 5000).hold).toBe(
      'too_long',
    );
  });

  it('draws the spot check in proportion to the tags, the same every time', () => {
    const books = [
      ...Array.from({ length: 40 }, (_, i) => ({ uuid: `m${i}`, matched: ['マンガ'] })),
      ...Array.from({ length: 60 }, (_, i) => ({ uuid: `g${i}`, matched: ['画像のみ'] })),
    ];
    const key = (u: string) => sha(Buffer.from(`x:${u}`));
    const a = drawSpot(books, ['マンガ', '画像のみ'], 30, key);
    const b = drawSpot([...books].reverse(), ['マンガ', '画像のみ'], 30, key);
    expect(a.length).toBe(30);
    expect(a.filter((x) => x.matched.includes('マンガ')).length).toBe(12);
    expect(a.map((x) => x.uuid).sort()).toEqual(b.map((x) => x.uuid).sort());
    expect(drawSpot(books.slice(0, 5), ['マンガ', '画像のみ'], 30, key).length).toBe(5);
    // A group with books always gets one.
    expect(
      drawSpot([...books.slice(0, 1), ...books.slice(40)], ['マンガ', '画像のみ'], 30, key).some(
        (x) => x.uuid === 'm0',
      ),
    ).toBe(true);
  });
});

describe('moving books to the manga library', () => {
  let env: CleanupEnv;
  let manga: LibraryFixture;
  const user = () => `Bearer ${env.userToken()}`;
  let userAuth = '';
  let apply = '';

  const mangaId = () => listLibraries(env.db).find((l) => l.folder === 'manga-library')!.id;
  const indexManga = async () => {
    manga.age();
    await env.indexer.checkLibrary(listLibraries(env.db).find((l) => l.id === mangaId())!);
  };
  const count = (bookId: string, chars: number, fileBytes: number) =>
    env.db
      .prepare(
        `INSERT OR REPLACE INTO char_counts (book_id, status, source_key, spec, characters, attempts, counted_at, file_bytes)
         VALUES (?, 'ok', 'k', 'v1', ?, 0, ?, ?)`,
      )
      .run(bookId, chars, Date.now(), fileBytes);
  const heartbeat = (version = '1.6.0') =>
    request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set('Authorization', apply)
      .send({
        ...healthyHeartbeat(),
        version,
        libraries: ['japanese-library', 'manga-library'],
        checks: [
          ...healthyHeartbeat().checks,
          { name: 'move_target', ok: true, detail: 'manga-library' },
        ],
      })
      .expect(200);

  beforeEach(async () => {
    const made = await makeCleanupEnv();
    env = made.env;
    await made.setup();
    manga = env.root.library('manga-library');
    await env.indexer.discover();
    updateLibrary(env.db, mangaId(), { language: 'ja', enabled: true });
    await indexManga();
    userAuth = user();
    apply = `Bearer ${env.applyToken()}`;
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set('Authorization', userAuth)
      .send({
        contentServerUrl: 'http://calibre:8081',
        calibreLibraryId: 'japanese-library',
        calibreUsername: 'u',
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set('Authorization', userAuth)
      .send({ value: 'pw' })
      .expect(200);
    await heartbeat();
  });

  afterEach(async () => {
    await env.close();
  });

  async function addBooks() {
    const epubA = mangaEpub();
    const epubB = bytes('b');
    const epubT = bytes('t');
    const a = await env.lib.addBook({
      title: 'よつばと!(1)',
      authors: ['あずまきよひこ'],
      tags: ['マンガ', 'TMW-collection-2'],
      series: { name: 'よつばと!', index: 1 },
      epub: epubA,
      coverHue: 10,
    });
    const b = await env.lib.addBook({
      title: '画集',
      authors: ['画家'],
      tags: ['画像のみ'],
      epub: epubB,
      coverHue: 20,
    });
    const t = await env.lib.addBook({
      title: '文字の多い本',
      authors: ['作家'],
      tags: ['マンガ'],
      epub: epubT,
    });
    const z = await env.lib.addBook({
      title: 'mokuro',
      authors: ['誰か'],
      tags: ['画像のみ'],
      formats: ['ZIP'],
    });
    const plain = await env.lib.addBook({
      title: 'ふつうの小説',
      authors: ['作家'],
      epub: bytes('p'),
    });
    await env.index();
    const lib = env.libraryId();
    const book = (id: number) => {
      const uuid = (
        env.lib['open']().prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }
      ).uuid;
      // A book without an EPUB has no reader record (the reader shows EPUB only).
      return { id, uuid, bookId: findCalibreSource(env.db, lib, uuid)?.bookId ?? '' };
    };
    const A = book(a);
    const B = book(b);
    const T = book(t);
    const Z = book(z);
    const P = book(plain);
    count(A.bookId, 120, epubA.length);
    count(B.bookId, 0, epubB.length);
    count(T.bookId, 80_000, epubT.length);
    env.addReaderData(A.bookId);
    return { A, B, T, Z, P, epubA, epubB };
  }

  async function runPass(max = 20) {
    for (let i = 0; i < max; i++) {
      const r = await env.service.move.step();
      if (r === 'idle' || r === 'wait') return r;
    }
    return 'more';
  }

  async function claimAndSave() {
    const claim = await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set('Authorization', apply)
      .expect(200);
    const batch = claim.body.batch;
    if (!batch) return { batch: null, wait: claim.body.wait as string };
    if (!batch.snapshotSaved) {
      const snap = await request(env.app)
        .get(`/api/v1/cleanup-apply/batches/${batch.id}/metadata-snapshot`)
        .set('Authorization', apply)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      await request(env.app)
        .post(`/api/v1/cleanup-apply/batches/${batch.id}/snapshot-saved`)
        .set('Authorization', apply)
        .send({ sha256: sha(snap.body as Buffer) })
        .expect(200);
    }
    return { batch, wait: null };
  }

  const report = (batchId: string, itemId: number, body: Record<string, unknown>, status = 200) =>
    request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batchId}/items/${itemId}`)
      .set('Authorization', apply)
      .send(body)
      .expect(status);

  /** Calibre's add of the export into the manga library (same files, every field). */
  async function addToManga(src: number, epub: Buffer, over: { sort?: string } = {}) {
    const row = env.lib['open']()
      .prepare('SELECT title, sort FROM books WHERE id = ?')
      .get(src) as { title: string; sort: string };
    const id = await manga.addBook({
      title: row.title,
      sort: over.sort ?? row.sort,
      epub,
      tags: ['マンガ'],
    });
    const cover = path.join(env.lib.bookDir(src), 'cover.jpg');
    if (fs.existsSync(cover)) fs.copyFileSync(cover, path.join(manga.bookDir(id), 'cover.jpg'));
    const uuid = (
      manga['open']().prepare('SELECT uuid FROM books WHERE id = ?').get(id) as {
        uuid: string;
      }
    ).uuid;
    return { id, uuid };
  }

  it('selects, holds, spot-checks, moves one book keeping its reader book and state, and moves it back', async () => {
    const { A, B, T, Z, P, epubA, epubB } = await addBooks();
    const lib = env.libraryId();
    // The cleanup's state about A (re-keyed with it) and an earlier stage-2 batch on A.
    const now = Date.now();
    env.cleanupDb
      .prepare(
        `INSERT INTO user_fields (library_id, calibre_uuid, field, source, since) VALUES (?, ?, 'title', 'edit', ?)`,
      )
      .run(lib, A.uuid, now);
    env.cleanupDb
      .prepare(
        `INSERT INTO applied_values (library_id, calibre_uuid, field, value_json, source, applied_at) VALUES (?, ?, 'series', '"よつばと!"', 'stage4', ?)`,
      )
      .run(lib, A.uuid, now);
    env.cleanupDb
      .prepare(
        `INSERT INTO ai_values (stage, item_key, field, value_json, source, decided_at) VALUES ('calibre4', ?, 'title', '"よつばと!(1)"', 'user', ?)`,
      )
      .run(`${lib}:${A.uuid}`, now);
    env.cleanupDb
      .prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, review_reason, state, analysis_id, created_at, updated_at)
         VALUES (4, ?, ?, ?, 'publisher', 'null', '"KADOKAWA"', 'rules', 'review', 'Two stores disagree', 'proposed', 'x', ?, ?)`,
      )
      .run(lib, A.id, A.uuid, now, now);
    env.cleanupDb
      .prepare(
        `INSERT INTO series_pair_decisions (library_id, name_a, name_b, decision, decided_at, decided_by) VALUES (?, 'よつばと!', 'よつばと!シリーズ', 'merged', ?, 'you')`,
      )
      .run(lib, now);

    // Preview: proposals, the held books, the spot check.
    env.service.move.setMode('analyse');
    await runPass();
    const st = getMoveState(env.cleanupDb);
    expect(st.progress.phase).toBe('spot');
    expect(st.progress.counts.tagged).toBe(4);
    expect(st.progress.counts.auto).toBe(2);
    expect(st.progress.counts.held).toEqual({ real_text: 1, no_epub: 1 });
    expect(st.progress.counts.withData).toBe(1);
    const held = env.service.move.heldList(lib, st.progress.run);
    expect(held.books.map((b) => [b.uuid, b.hold]).sort()).toEqual(
      [
        [T.uuid, 'real_text'],
        [Z.uuid, 'no_epub'],
      ].sort(),
    );
    expect(
      env.cleanupDb
        .prepare(`SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = ? AND calibre_uuid = ?`)
        .get(MOVE_STAGE, P.uuid),
    ).toEqual({ n: 0 });
    // On only after the spot check: every book marked, none wrong.
    const spot = env.service.move.spotList();
    expect(spot.map((b) => b.uuid).sort()).toEqual([A.uuid, B.uuid].sort());
    expect(() => env.service.move.setMode('on')).toThrow(/spot check/);
    env.service.move.setVerdict(A.uuid, 'right');
    env.service.move.setVerdict(B.uuid, 'wrong');
    expect(() => env.service.move.setMode('on')).toThrow(/spot check/);
    env.service.move.setVerdict(B.uuid, 'right');
    // Keep B here (a choice on a held book works on automatic ones too: kept is never moved).
    env.service.move.choose(
      env.service.move.spotList().find((b) => b.uuid === B.uuid)!.changeId,
      'keep',
    );
    env.service.move.setMode('on');

    // An older sidecar never gets a move batch.
    await heartbeat('1.5.0');
    await runPass();
    expect(getMoveState(env.cleanupDb).progress.write.waiting).toMatch(/older than 1\.6\.0/);
    await heartbeat();
    await runPass();
    const { batch } = await claimAndSave();
    expect(batch).not.toBeNull();
    expect(batch.stage).toBe(MOVE_STAGE);
    expect(batch.calibreLibrary).toBe('japanese-library');
    expect(batch.targetCalibreLibrary).toBe('manga-library');
    expect(batch.items.map((i: { uuid: string }) => i.uuid)).toEqual([A.uuid]);
    const item = batch.items[0];
    // Both libraries' index waits while the batch is claimed.
    expect(env.service.holdsIngest(lib)).toBe(true);
    expect(env.service.holdsIngest(mangaId())).toBe(true);

    await report(batch.id, item.itemId, { step: 'verified' });
    await report(batch.id, item.itemId, {
      step: 'exported',
      quarantineDir: '/quarantine/x/1',
      exportSha256: sha(epubA),
    });
    // The server's half of the check: a copy whose sort differs fails it.
    const wrong = await addToManga(A.id, epubA, { sort: 'other sort' });
    const bad = await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/items/${item.itemId}/move-check`)
      .set('Authorization', apply)
      .send({ calibreId: wrong.id, uuid: wrong.uuid })
      .expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems.join(' ')).toMatch(/title sort/);
    manga.removeBook(wrong.id);
    // A copy with one page changed inside fails; one packed again with the same files passes.
    const changed = await addToManga(A.id, mangaEpub({ repack: true, page: '3' }));
    const differs = await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/items/${item.itemId}/move-check`)
      .set('Authorization', apply)
      .send({ calibreId: changed.id, uuid: changed.uuid })
      .expect(200);
    expect(differs.body.ok).toBe(false);
    expect(differs.body.problems.join(' ')).toMatch(/OEBPS\/p2\.jpg differs/);
    manga.removeBook(changed.id);
    const repacked = mangaEpub({ repack: true });
    expect(sha(repacked)).not.toBe(sha(epubA));
    const copy = await addToManga(A.id, repacked);
    const good = await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/items/${item.itemId}/move-check`)
      .set('Authorization', apply)
      .send({ calibreId: copy.id, uuid: copy.uuid })
      .expect(200);
    expect(good.body).toEqual({ ok: true, problems: [] });
    await report(batch.id, item.itemId, {
      step: 'tagged',
      calibreId: copy.id,
      uuid: copy.uuid,
      fields: { title: 'よつばと!(1)' },
    });
    env.lib.trashBook(A.id);
    await report(batch.id, item.itemId, { step: 'removed' });
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/finish`)
      .set('Authorization', apply)
      .send({})
      .expect(200);

    // The reader keeps the same book, now in the manga library.
    const there = findCalibreSource(env.db, mangaId(), copy.uuid);
    expect(there?.bookId).toBe(A.bookId);
    expect(findCalibreSource(env.db, lib, A.uuid)).toBeNull();
    expect(
      (
        env.db.prepare('SELECT library_id FROM books WHERE id = ?').get(A.bookId) as {
          library_id: string;
        }
      ).library_id,
    ).toBe(mangaId());
    // The cleanup's state followed the book.
    const m = { lib: mangaId(), uuid: copy.uuid };
    const one = (sql: string, ...p: unknown[]) => env.cleanupDb.prepare(sql).get(...p);
    expect(
      one('SELECT field FROM user_fields WHERE library_id = ? AND calibre_uuid = ?', m.lib, m.uuid),
    ).toEqual({ field: 'title' });
    expect(
      one(
        'SELECT field FROM applied_values WHERE library_id = ? AND calibre_uuid = ?',
        m.lib,
        m.uuid,
      ),
    ).toEqual({ field: 'series' });
    expect(one('SELECT source FROM ai_values WHERE item_key = ?', `${m.lib}:${m.uuid}`)).toEqual({
      source: 'user',
    });
    expect(
      one(
        `SELECT calibre_id, state FROM proposed_changes WHERE stage = 4 AND library_id = ? AND calibre_uuid = ?`,
        m.lib,
        m.uuid,
      ),
    ).toEqual({ calibre_id: copy.id, state: 'proposed' });
    expect(one(`SELECT decision FROM series_pair_decisions WHERE library_id = ?`, m.lib)).toEqual({
      decision: 'merged',
    });
    expect(one(`SELECT decision FROM series_pair_decisions WHERE library_id = ?`, lib)).toEqual({
      decision: 'merged',
    });
    // The move's own record stays under the old identity.
    expect(
      one(
        `SELECT state FROM proposed_changes WHERE stage = ? AND calibre_uuid = ?`,
        MOVE_STAGE,
        A.uuid,
      ),
    ).toEqual({ state: 'applied' });

    // The indexes take it in: the book appears in the manga library, nothing becomes "yours".
    await env.index();
    await indexManga();
    await env.service.tick();
    const src = findCalibreSource(env.db, mangaId(), copy.uuid)!;
    expect(src.missingAt).toBeNull();
    expect(
      env.db
        .prepare('SELECT COUNT(*) AS n FROM calibre_field_changes WHERE book_id = ?')
        .get(A.bookId),
    ).toEqual({ n: 0 });
    expect(
      (
        env.cleanupDb.prepare('SELECT ingested_at FROM batches WHERE id = ?').get(batch.id) as {
          ingested_at: number | null;
        }
      ).ingested_at,
    ).not.toBeNull();
    expect(getMoveState(env.cleanupDb).pausedReason).toBeNull();

    // Undo: the book comes back (Calibre's trash), the moved copy goes, everything follows back.
    const undo = await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set('Authorization', userAuth)
      .expect(200);
    expect(undo.body.batch?.kind ?? undo.body.kind).toBe('undo');
    // Calibre's trash keeps the removed book's folder (.caltrash/b/<id>), which the server reads.
    fs.mkdirSync(path.join(env.root.dir, 'japanese-library', '.caltrash', 'b', String(A.id)), {
      recursive: true,
    });
    const u = await claimAndSave();
    expect(u.batch.items[0].move.movedCopy).toEqual({ calibreId: copy.id, uuid: copy.uuid });
    expect(u.batch.items[0].inCalibreTrash).toBe(true);
    env.lib.trashRestore(A.id);
    manga.trashBook(copy.id);
    await report(u.batch.id, u.batch.items[0].itemId, {
      step: 'restored',
      method: 'trash',
      calibreId: A.id,
      uuid: A.uuid,
    });
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${u.batch.id}/finish`)
      .set('Authorization', apply)
      .send({})
      .expect(200);
    expect(findCalibreSource(env.db, lib, A.uuid)?.bookId).toBe(A.bookId);
    expect(
      one('SELECT field FROM user_fields WHERE library_id = ? AND calibre_uuid = ?', lib, A.uuid),
    ).toEqual({ field: 'title' });
    expect(one('SELECT source FROM ai_values WHERE item_key = ?', `${lib}:${A.uuid}`)).toEqual({
      source: 'user',
    });
    expect(one('SELECT state FROM calibre_moves WHERE from_uuid = ?', A.uuid)).toEqual({
      state: 'undone',
    });
    expect(one('SELECT state FROM batches WHERE id = ?', batch.id)).toEqual({ state: 'undone' });
    await env.index();
    await indexManga();
    expect(findCalibreSource(env.db, lib, A.uuid)?.missingAt).toBeNull();
    expect(epubB.length).toBeGreaterThan(0);
    // The move is still On: the library changed (the book is back), so it selects again, and a
    // book you moved back is never moved again by itself (found in the NAS-scale e2e).
    await env.service.batches.checkIngested();
    for (let i = 0; i < 10; i++) if ((await env.service.move.step()) !== 'more') break;
    expect(
      one(
        `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = ? AND calibre_uuid = ? AND state = 'proposed'`,
        MOVE_STAGE,
        A.uuid,
      ),
    ).toEqual({ n: 0 });
    // Nor when the Undo re-added it from the quarantine (a new UUID): its move record names it.
    env.cleanupDb
      .prepare(`UPDATE calibre_moves SET back_uuid = 'readded-uuid' WHERE from_uuid = ?`)
      .run(A.uuid);
    const r = env.service.move.propose(lib, mangaId(), 'move:test', [
      {
        candidate: {
          calibreId: 99,
          uuid: 'readded-uuid',
          title: 'x',
          authors: ['y'],
          lastModified: null,
          path: 'p',
          epubPath: 'p/x.epub',
          epubSize: 1,
          formats: ['EPUB'],
          tags: ['マンガ'],
          matched: ['マンガ'],
          series: null,
        },
        reader: null,
        hold: null,
        detail: null,
      },
    ]);
    expect(r).toMatchObject({ auto: 0, already: 1 });
  });

  it('a new-arrivals run waits for the reader to count its tagged books before it decides (at most the setting)', async () => {
    const { A } = await addBooks();
    const epubN = mangaEpub({ page: 'n' });
    const n = await env.lib.addBook({
      title: '新刊',
      authors: ['作者'],
      tags: ['マンガ'],
      epub: epubN,
    });
    await env.index();
    const lib = env.libraryId();
    const uuidN = (
      env.lib['open']().prepare('SELECT uuid FROM books WHERE id = ?').get(n) as { uuid: string }
    ).uuid;
    const N = { id: n, uuid: uuidN, bookId: findCalibreSource(env.db, lib, uuidN)!.bookId };
    await heartbeat();
    setMoveMode(env.cleanupDb, 'on');
    env.service.arrivals.setMode('on');
    /** A run of the new arrivals at its move step, with these books as its own. */
    const startRun = (ids: number[], waitSince: number | null = null) => {
      const now = Date.now();
      const p = {
        phase: 'move',
        phaseStartedAt: now,
        phaseStartDone: 0,
        times: {},
        counts: {},
        waiting: null,
        pairs: [],
        libraryId: lib,
        scope: { import: ids, hand: [] },
        betterOf: {},
        reviews: 0,
        stage4: null,
        ai: null,
        s5: null,
        jGate: null,
        writes: {},
        check: null,
        moveCountWaitSince: waitSince,
        cost: 0,
      };
      const id = Number(
        env.cleanupDb
          .prepare(
            `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json)
             VALUES ('now', 'on', 'running', 'move', ?, ?)`,
          )
          .run(now, JSON.stringify(p)).lastInsertRowid,
      );
      env.cleanupDb
        .prepare('UPDATE calibre_arrivals_state SET current_run = ? WHERE id = 1')
        .run(id);
      return id;
    };
    const proposed = (run: number) =>
      (
        env.cleanupDb
          .prepare(
            `SELECT calibre_uuid FROM proposed_changes WHERE stage = ${MOVE_STAGE} AND analysis_id = ?`,
          )
          .all(moveArrivalsAnalysisId(run)) as { calibre_uuid: string }[]
      ).map((r) => r.calibre_uuid);

    // N isn't counted yet: the run waits and decides nothing.
    const run1 = startRun([A.id, N.id]);
    expect(await env.service.arrivals.step()).toBe('wait');
    let p = env.service.arrivals.currentRun()!.p;
    expect(p.waiting).toBe(
      'Waiting for the reader to count 1 of the 2 manga and image-only books before moving them',
    );
    expect(p.move ?? null).toBeNull();
    expect(proposed(run1)).toEqual([]);
    // Counted: it decides, and both are moved (none held as "no count").
    count(N.bookId, 40, epubN.length);
    await env.service.arrivals.step();
    p = env.service.arrivals.currentRun()!.p;
    expect(p.move).toMatchObject({ tagged: 2, auto: 2, held: {} });
    expect(p.waiting).not.toMatch(/count/);
    expect(proposed(run1).sort()).toEqual([A.uuid, N.uuid].sort());
    env.cleanupDb.prepare(`UPDATE calibre_arrival_runs SET state = 'done' WHERE id = ?`).run(run1);

    // Past the setting's wait, a book still uncounted is held (no count), not waited for again.
    const epubM = mangaEpub({ page: 'm' });
    const m = await env.lib.addBook({
      title: '新刊2',
      authors: ['作者'],
      tags: ['画像のみ'],
      epub: epubM,
    });
    await env.index();
    updateSettings(env.cleanupDb, {
      move: { ...getSettings(env.cleanupDb).move, arrivalsCountWaitMinutes: 30 },
    });
    const run2 = startRun([m], Date.now() - 31 * 60_000);
    await env.service.arrivals.step();
    p = env.service.arrivals.currentRun()!.p;
    expect(p.move).toMatchObject({ tagged: 1, auto: 0, held: { no_count: 1 } });
    expect(proposed(run2)).toHaveLength(1);
  });

  it('a field batch written before the move is not undone on a moved book', async () => {
    const { A } = await addBooks();
    const lib = env.libraryId();
    const now = Date.now();
    env.cleanupDb
      .prepare(
        `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at, snapshot_saved)
         VALUES ('old2', 2, ?, 'apply', 'applied', 1, ?, ?, 1)`,
      )
      .run(lib, now - 10_000, now - 10_000);
    const c = env.cleanupDb
      .prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, state, batch_id, created_at, updated_at)
         VALUES (2, ?, ?, ?, 'publisher', 'null', '"X"', 'file', 'auto', 'applied', 'old2', ?, ?)`,
      )
      .run(lib, A.id, A.uuid, now, now).lastInsertRowid;
    env.cleanupDb
      .prepare(
        `INSERT INTO field_undo (batch_id, change_id, library_id, calibre_id, calibre_uuid, field, old_json, new_json, created_at)
         VALUES ('old2', ?, ?, ?, ?, 'publisher', 'null', '"X"', ?)`,
      )
      .run(c, lib, A.id, A.uuid, now);
    env.cleanupDb
      .prepare(
        `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at, target_library_id)
         VALUES ('mv', ?, ?, 'apply', 'applied', 1, ?, ?, ?)`,
      )
      .run(MOVE_STAGE, lib, now, now, mangaId());
    const mc = env.cleanupDb
      .prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, source, class, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'book', 'move', 'auto', 'applied', ?, ?)`,
      )
      .run(MOVE_STAGE, lib, A.id, A.uuid, now, now).lastInsertRowid;
    env.cleanupDb
      .prepare(
        `INSERT INTO calibre_moves (change_id, batch_id, from_library_id, from_calibre_id, from_uuid, to_library_id, to_calibre_id, to_uuid, state, moved_at)
         VALUES (?, 'mv', ?, ?, ?, ?, 9, 'new-uuid', 'moved', ?)`,
      )
      .run(mc, lib, A.id, A.uuid, mangaId(), now);
    const r = await request(env.app)
      .post('/api/v1/cleanup/batches/old2/undo')
      .set('Authorization', userAuth)
      .expect(409);
    expect(r.body.error.message).toMatch(/moved to another library/);
  });

  it('re-keys every table it names, and back again', async () => {
    const lib = 'L1';
    const to = { libraryId: 'L2', calibreId: 9, uuid: 'new' };
    const from = { libraryId: lib, calibreId: 1, uuid: 'old' };
    const db = env.cleanupDb;
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage4_series_order (library_id, calibre_uuid, calibre_id, series, series_key, src, run_at) VALUES (?, 'old', 1, 'S', 's', 'store', ?)`,
    ).run(lib, now);
    db.prepare(
      `INSERT INTO calibre_marks (library_id, calibre_uuid, tag, recorded_at) VALUES (?, 'old', 'x', 1)`,
    ).run(lib);
    for (const st of CALIBRE_AI_STAGES)
      db.prepare(
        `INSERT INTO ai_item_designs (stage, item_key, design, set_at) VALUES (?, ?, 'E', 1)`,
      ).run(st, `${lib}:old`);
    db.prepare(
      `INSERT INTO link_discovery_picks (library_id, calibre_uuid, site, calibre_id, store_id, store_title, how, updated_at)
       VALUES (?, 'old', 'amazon', 1, 'B0X', 't', 'record', 1)`,
    ).run(lib);
    db.prepare(
      `INSERT INTO link_discovery_spot (library_id, calibre_uuid, site, position, how) VALUES (?, 'old', 'amazon', 0, 'record')`,
    ).run(lib);
    const n = rekeyCleanupState(db, from, to, ['S']);
    expect(n.link_discovery_picks).toBe(1);
    expect(n.link_discovery_spot).toBe(1);
    expect(n.stage4_series_order).toBe(1);
    expect(n.calibre_marks).toBe(1);
    expect(n.ai_item_designs).toBe(CALIBRE_AI_STAGES.length);
    expect(
      db
        .prepare(
          'SELECT calibre_id FROM stage4_series_order WHERE library_id = ? AND calibre_uuid = ?',
        )
        .get('L2', 'new'),
    ).toEqual({ calibre_id: 9 });
    rekeyCleanupState(db, to, from);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ai_item_designs WHERE item_key = ?`).get(`${lib}:old`),
    ).toEqual({
      n: CALIBRE_AI_STAGES.length,
    });
  });

  it('the re-key and the move queries use their indexes (no full scan of a big table)', () => {
    const db = env.cleanupDb;
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    const scans = (s: string) =>
      /\bSCAN (proposed_changes|ai_requests|ai_values|ai_items|applied_values|user_fields|stage4_books|calibre_moves|batches)\b/.test(
        s,
      );
    for (const sql of [
      `UPDATE proposed_changes SET library_id = 'a' WHERE library_id = 'x' AND calibre_uuid = 'y' AND field <> 'book'`,
      `UPDATE ai_requests SET item_key = 'n' WHERE stage IN ('calibre4','calibre5','bookmeter-near','bookmeter-near2') AND item_key = 'o'`,
      `UPDATE ai_values SET item_key = 'n' WHERE stage IN ('calibre4','calibre5') AND item_key = 'o'`,
      `UPDATE stage4_books SET library_id = 'a' WHERE library_id = 'x' AND calibre_uuid = 'y'`,
      `SELECT to_library_id FROM calibre_moves WHERE from_library_id = 'x' AND from_uuid = 'y' AND state = 'moved'`,
      `SELECT COUNT(*) FROM proposed_changes INDEXED BY proposed_changes_move WHERE stage = 11 AND library_id = 'x' AND analysis_id = 'move:1' AND state = 'proposed' AND class = 'auto'`,
    ]) {
      const p = plan(sql);
      expect(scans(p), `${sql}\n${p}`).toBe(false);
    }
  });

  it('a reader edit of a book in another library goes only to a sidecar that uses each batch’s library', async () => {
    await heartbeat('1.5.0');
    const now = Date.now();
    env.cleanupDb
      .prepare(
        `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at, snapshot_saved)
         VALUES ('ed', 10, ?, 'apply', 'planned', 0, ?, ?, 1)`,
      )
      .run(mangaId(), now, now);
    let claim = await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set('Authorization', apply)
      .expect(200);
    expect(claim.body.batch).toBeNull();
    expect(claim.body.wait).toMatch(/older than 1\.6\.0/);
    await heartbeat();
    claim = await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set('Authorization', apply)
      .expect(200);
    expect(claim.body.batch.calibreLibrary).toBe('manga-library');
    updateSettings(env.cleanupDb, {});
  });
});
