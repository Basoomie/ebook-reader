/**
 * Manga part B (manga-library.md, approved 2026-11-25): the cleanup across the Calibre libraries.
 * The migration (cleanup.db v38) gives today's state to the primary library; stages, pauses,
 * checks, passes and new-arrivals runs are per library; one gate across them; a new copy is
 * checked against the other library too (a copy there is recorded, never added); add batches
 * name their library.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLibraries, updateLibrary } from '../src/calibre/libraries';
import {
  CLEANUP_MIGRATIONS,
  CLEANUP_SCHEMA_VERSION,
  LIBRARY_SCOPE_VERSION,
  migrateCleanup,
} from '../src/cleanup/cleanup-db';
import { gateParts, saveGatePart, unionOfParts } from '../src/cleanup/gate-parts';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import {
  listFieldPauses,
  mapLabeledIds,
  pauseField,
  resumeField,
} from '../src/cleanup/stage2-gate';
import {
  currentAnalysisId,
  getStage,
  listStages,
  pauseStage,
  setStageMode,
  stageLibraries,
  updateStage,
} from '../src/cleanup/stages';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { healthyHeartbeat, makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { chaptersOf, makeTextEpub } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;

/** A cleanup.db at v36 (the live version before part B), in memory. */
function v36(): Database.Database {
  const db = new Database(':memory:');
  for (const m of CLEANUP_MIGRATIONS.filter((x) => x.version < LIBRARY_SCOPE_VERSION)) {
    db.exec(m.sql);
    db.pragma(`user_version = ${m.version}`);
  }
  return db;
}

describe('cleanup.db v38: every stage, pass and import run belongs to a library', () => {
  it('gives the primary library today’s rows, keeps run 7 its run, and the gate’s pauses to every library', () => {
    expect(CLEANUP_SCHEMA_VERSION).toBe(LIBRARY_SCOPE_VERSION);
    const db = v36();
    db.prepare(
      `UPDATE stages SET mode = 'on', state = 'ready', progress_json = '{"analysisId":"a4","libraryId":"J"}' WHERE stage = 4`,
    ).run();
    db.prepare(
      `UPDATE stages SET mode = 'analyse', pause_reason = 'library_changed' WHERE stage = 2`,
    ).run();
    db.prepare(
      `INSERT INTO stage_field_pauses (stage, field, reason, detail, paused_at) VALUES
         (2, 'title', 'gate', 'below', 1), (4, 'series', 'failures', 'x', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO preflight (name, ok, detail, source, checked_at) VALUES ('illustrator_column', 1, NULL, 'sidecar', 1)`,
    ).run();
    db.prepare(`UPDATE bookmeter_more_state SET mode = 'analyse', library_id = 'J'`).run();
    db.prepare(
      `UPDATE link_discovery_state SET mode = 'on', progress_json = '{"phase":"done","run":3}'`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_arrival_pairs (pair_key, pair_id, source, library_id, created_at)
       VALUES ('ja|books/japanese', 'ja', 'books/japanese', 'J', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_arrival_runs (id, trigger, mode, state, phase, started_at, progress_json)
       VALUES (7, 'now', 'on', 'running', 'stage4', 1, '{"libraryId":"J","phase":"stage4"}')`,
    ).run();
    db.prepare(
      `UPDATE calibre_arrivals_state SET mode = 'on', current_run = 7, baseline_at = 5`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_arrival_files (id, pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind, outcome, calibre_id, calibre_uuid)
       VALUES (1, 'ja|books/japanese', 'a.epub', 1, 1, 1, 1, 'epub', 'added', 11, 'u11'),
              (2, 'ja|books/japanese', 'b.epub', 1, 1, 1, 1, 'epub', 'new', NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_arrival_books (run_id, library_id, calibre_id, calibre_uuid, origin) VALUES (7, 'J', 11, 'u11', 'import')`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at) VALUES ('J', 11, 'u11', 'import', 1)`,
    ).run();

    migrateCleanup(db, { primaryLibrary: () => 'J' });

    expect(stageLibraries(db)).toEqual(['J']);
    expect(getStage(db, 'J', 4)).toMatchObject({ mode: 'on', state: 'ready', libraryId: 'J' });
    expect(currentAnalysisId(db, 'J', 4)).toBe('a4');
    expect(getStage(db, 'J', 2)).toMatchObject({ mode: 'analyse', pauseReason: 'library_changed' });
    // A gate's pause holds in every library; another reason only in its own.
    expect(listFieldPauses(db, 'J', 2).map((p) => p.field)).toEqual(['title']);
    expect(listFieldPauses(db, 'M', 2).map((p) => p.field)).toEqual(['title']);
    expect(listFieldPauses(db, 'J', 4).map((p) => p.field)).toEqual(['series']);
    expect(listFieldPauses(db, 'M', 4)).toEqual([]);
    // Another library starts with every stage Off.
    expect(listStages(db, 'M').every((s) => s.mode === 'off')).toBe(true);
    expect(stageLibraries(db)).toEqual(['J', 'M']);
    // The passes: their own row (a row never run goes to the primary library).
    expect(db.prepare('SELECT library_id, mode FROM bookmeter_more_state').all()).toEqual([
      { library_id: 'J', mode: 'analyse' },
    ]);
    expect(db.prepare('SELECT library_id, mode FROM link_discovery_state').all()).toEqual([
      { library_id: 'J', mode: 'on' },
    ]);
    // Run 7 stays the primary library's current run.
    expect(
      db
        .prepare('SELECT library_id, mode, current_run, baseline_at FROM calibre_arrivals_state')
        .all(),
    ).toEqual([{ library_id: 'J', mode: 'on', current_run: 7, baseline_at: 5 }]);
    expect(db.prepare('SELECT library_id FROM calibre_arrival_runs WHERE id = 7').get()).toEqual({
      library_id: 'J',
    });
    // A file names the library of its Calibre book (its pair's, until now).
    expect(
      db.prepare('SELECT id, calibre_library_id FROM calibre_arrival_files ORDER BY id').all(),
    ).toEqual([
      { id: 1, calibre_library_id: 'J' },
      { id: 2, calibre_library_id: null },
    ]);
    expect(db.prepare('SELECT preflight.library_id FROM preflight').all()).toEqual([
      { library_id: '' },
    ]);
    // 'move' is a known book's origin now.
    db.prepare(
      `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at) VALUES ('M', 3, 'u3', 'move', 1)`,
    ).run();
    db.close();
  });

  it('without the reader’s database (a tool, a test) keeps today’s rows for the first library that asks', () => {
    const db = v36();
    db.prepare(`UPDATE stages SET mode = 'analyse', state = 'ready' WHERE stage = 3`).run();
    db.prepare(`UPDATE calibre_arrivals_state SET mode = 'analyse'`).run();
    migrateCleanup(db);
    expect(stageLibraries(db)).toEqual([]);
    expect(getStage(db, 'L', 3)).toMatchObject({ mode: 'analyse', state: 'ready' });
    expect(stageLibraries(db)).toEqual(['L']);
    db.close();
  });

  it('a statement naming a Calibre book without its library means the file’s own; one naming another keeps it', () => {
    const db = v36();
    migrateCleanup(db, { primaryLibrary: () => 'J' });
    db.prepare(
      `INSERT INTO calibre_arrival_pairs (pair_key, pair_id, source, library_id, created_at)
       VALUES ('m|manga', 'm', 'manga', 'M', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO calibre_arrival_files (id, pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind)
       VALUES (1, 'm|manga', 'a.epub', 1, 1, 1, 1, 'epub')`,
    ).run();
    const lib = () =>
      (
        db
          .prepare('SELECT calibre_library_id AS l FROM calibre_arrival_files WHERE id = 1')
          .get() as {
          l: string | null;
        }
      ).l;
    db.prepare(
      `UPDATE calibre_arrival_files SET outcome = 'identical', calibre_id = 5 WHERE id = 1`,
    ).run();
    expect(lib()).toBe('M');
    db.prepare(
      `UPDATE calibre_arrival_files SET calibre_id = 9, calibre_library_id = 'J' WHERE id = 1`,
    ).run();
    expect(lib()).toBe('J');
    db.prepare(
      `UPDATE calibre_arrival_files SET outcome = 'new', calibre_id = NULL WHERE id = 1`,
    ).run();
    expect(lib()).toBeNull();
    db.close();
  });
});

describe('the stages, their pauses and the gate per library', () => {
  it('keeps each library’s modes, state and pauses apart', () => {
    const db = v36();
    migrateCleanup(db, { primaryLibrary: () => 'J' });
    setStageMode(db, 'M', 1, 'on');
    updateStage(db, 'M', 1, { state: 'analysing', progress: { analysisId: 'm1' } });
    pauseStage(db, 'M', 3, 'library_changed', 'x');
    expect(getStage(db, 'J', 1)).toMatchObject({ mode: 'off', state: 'idle' });
    expect(currentAnalysisId(db, 'J', 1)).toBeNull();
    expect(currentAnalysisId(db, 'M', 1)).toBe('m1');
    expect(getStage(db, 'J', 3).pauseReason).toBeNull();
    expect(getStage(db, 'M', 3).pauseReason).toBe('library_changed');
    // A failure pause is the library's; a gate's every library's, lifted by either.
    pauseField(db, 'M', 4, 'title', 'failures', 'x');
    pauseField(db, 'M', 4, 'series', 'gate', 'below');
    expect(listFieldPauses(db, 'J', 4).map((p) => [p.field, p.reason])).toEqual([
      ['series', 'gate'],
    ]);
    expect(listFieldPauses(db, 'M', 4).map((p) => p.field)).toEqual(['series', 'title']);
    resumeField(db, 'J', 4, 'series');
    expect(listFieldPauses(db, 'M', 4).map((p) => p.field)).toEqual(['title']);
    db.close();
  });

  it('a labeled book follows its move: counted in the library it moved to, not the old one', () => {
    const db = v36();
    migrateCleanup(db, { primaryLibrary: () => 'J' });
    db.pragma('foreign_keys = OFF');
    getStage(db, 'J', 1); // the primary library's rows came first
    getStage(db, 'M', 1);
    db.prepare(
      `INSERT INTO calibre_moves (change_id, batch_id, from_library_id, from_calibre_id, from_uuid, to_library_id, to_calibre_id, to_uuid, state, moved_at)
       VALUES (1, 'b', 'J', 20, 'u20', 'M', 7, 'm7', 'moved', 1),
              (2, 'b', 'J', 30, 'u30', 'M', 8, 'm8', 'undone', 1)`,
    ).run();
    expect([...mapLabeledIds(db, 'J', ['10', '20', '30'])]).toEqual([
      ['10', 10],
      ['30', 30],
    ]);
    expect([...mapLabeledIds(db, 'M', ['10', '20', '30'])]).toEqual([['20', 7]]);
    db.close();
  });

  it('scores the gate over every library’s part', () => {
    const db = v36();
    migrateCleanup(db, { primaryLibrary: () => 'J' });
    saveGatePart(db, 4, 'rules', 'J', [{ gid: '1' }, { gid: '2' }]);
    saveGatePart(db, 4, 'rules', 'M', [{ gid: '3' }]);
    expect(unionOfParts<{ gid: string }>(db, 4, 'rules', 'M').map((b) => b.gid)).toEqual([
      '3',
      '1',
      '2',
    ]);
    saveGatePart(db, 4, 'rules', 'M', []);
    expect(gateParts(db, 4, 'rules').map((p) => p.libraryId)).toEqual(['J', 'M']);
    expect(unionOfParts(db, 4, 'rules', 'J')).toHaveLength(2);
    db.close();
  });
});

describe('two libraries: the service, the checks and the new arrivals', () => {
  let env: CleanupEnv;
  let sources: string;
  let apply: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const J: Record<string, number> = {};
  const M: Record<string, number> = {};
  const A = makeTextEpub({ title: 'A', chapters: chaptersOf(11) });
  const B = makeTextEpub({ title: 'B', chapters: chaptersOf(12) });
  const Bcopy = makeTextEpub({ title: 'B 新装版', chapters: chaptersOf(12) });
  const C = makeTextEpub({ title: 'C', chapters: chaptersOf(13) });
  const D = makeTextEpub({ title: 'D', chapters: chaptersOf(14) });
  let manga: ReturnType<CleanupEnv['root']['library']>;
  const mangaId = () => listLibraries(env.db).find((l) => l.folder === 'manga-library')!.id;

  const settle = async () => {
    for (let i = 0; i < 600 && env.service.libraryBusy(); i++)
      await new Promise((r) => setTimeout(r, 50));
  };
  const steps = async (max = 300) => {
    for (let i = 0; i < max; i++) {
      await settle();
      const r = await env.service.arrivals.step();
      if (r === 'idle' || r === 'wait') return;
    }
  };
  const outcome = (rel: string) =>
    env.cleanupDb
      .prepare(
        'SELECT outcome, calibre_id, calibre_library_id FROM calibre_arrival_files WHERE rel_path = ? AND gone_at IS NULL',
      )
      .get(rel) as {
      outcome: string;
      calibre_id: number | null;
      calibre_library_id: string | null;
    };

  beforeAll(async () => {
    sources = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-mangab-'));
    fs.mkdirSync(path.join(sources, 'books', 'japanese'), { recursive: true });
    fs.mkdirSync(path.join(sources, 'manga'), { recursive: true });
    const made = await makeCleanupEnv({
      service: {
        stage3Reader: new InProcessReader(bundle, IMPORT),
        counterBuild: 'test',
        bookSourcesDir: sources,
        bookSourcesReadOnly: false,
      },
    });
    env = made.env;
    manga = env.root.library('manga-library');
    J.A = await env.lib.addBook({ title: 'A', authors: ['作者'], epub: A });
    J.B = await env.lib.addBook({ title: 'B', authors: ['作者'], epub: B });
    M.C = await manga.addBook({ title: 'C', authors: ['作者'], epub: C });
    await made.setup();
    updateLibrary(env.db, mangaId(), { language: 'ja', enabled: true });
    manga.age();
    await env.indexer.checkLibrary(listLibraries(env.db).find((l) => l.id === mangaId())!);
    apply = env.applyToken();
    const user = env.userToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: 'http://calibre:8081',
        calibreLibraryId: 'japanese-library',
        calibreUsername: 'u',
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: 'pw' })
      .expect(200);
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(auth(apply))
      .send({ ...healthyHeartbeat(), libraries: ['japanese-library', 'manga-library'] })
      .expect(200);
    updateSettings(env.cleanupDb, {
      arrivals: {
        ...getSettings(env.cleanupDb).arrivals,
        pairs: [
          { id: 'ja', source: 'books/japanese', libraryId: env.libraryId() },
          { id: 'manga', source: 'manga', libraryId: mangaId() },
        ],
        settleMinutes: 0,
        handCheckMinutes: 0,
      },
      ai: { ...getSettings(env.cleanupDb).ai, booksArrivalsDesign: 'E' },
    });
    for (const lib of [env.libraryId(), mangaId()])
      for (const st of [1, 2, 3, 4, 5]) setStageMode(env.cleanupDb, lib, st, 'analyse');
    // japanese-library's folder: a copy of manga-library's C (the same bytes), and a new D.
    fs.writeFileSync(path.join(sources, 'books', 'japanese', 'C again.epub'), C);
    fs.writeFileSync(path.join(sources, 'books', 'japanese', 'D.epub'), D);
    // manga's folder: japanese-library's A (the same bytes) and B's text in another edition.
    fs.writeFileSync(path.join(sources, 'manga', 'A again.epub'), A);
    fs.writeFileSync(path.join(sources, 'manga', 'B again.epub'), Bcopy);
  }, 120_000);

  afterAll(async () => {
    await env?.close();
    fs.rmSync(sources, { recursive: true, force: true });
  });

  it('works on both libraries, each with its own stages, and names them on the page', async () => {
    expect(env.service.cleanupLibraries()).toEqual([env.libraryId(), mangaId()]);
    const libs = await request(env.app)
      .get('/api/v1/cleanup/libraries')
      .set(auth(env.userToken()))
      .expect(200);
    expect(
      libs.body.libraries.map((l: { folder: string; primary: boolean }) => [l.folder, l.primary]),
    ).toEqual([
      ['japanese-library', true],
      ['manga-library', false],
    ]);
    const st = await request(env.app)
      .get(`/api/v1/cleanup/status?library=${mangaId()}`)
      .set(auth(env.userToken()))
      .expect(200);
    expect(st.body.target.folder).toBe('manga-library');
    expect(st.body.stages.every((s: { libraryId: string }) => s.libraryId === mangaId())).toBe(
      true,
    );
    // A library the cleanup doesn't work on is refused.
    await request(env.app)
      .get('/api/v1/cleanup/status?library=nope')
      .set(auth(env.userToken()))
      .expect(400);
    // Setting manga-library's stage 1 Off leaves japanese-library's in Preview.
    await request(env.app)
      .put(`/api/v1/cleanup/stages/1?library=${mangaId()}`)
      .set(auth(env.userToken()))
      .send({ mode: 'off' })
      .expect(200);
    expect(getStage(env.cleanupDb, mangaId(), 1).mode).toBe('off');
    expect(getStage(env.cleanupDb, env.libraryId(), 1).mode).toBe('analyse');
    setStageMode(env.cleanupDb, mangaId(), 1, 'analyse');
  });

  it('keeps #illustrator per library (sidecar 1.7.0) and an older sidecar’s for the primary one', async () => {
    const hb = healthyHeartbeat();
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(auth(apply))
      .send({
        ...hb,
        libraries: ['japanese-library', 'manga-library'],
        checks: [
          ...hb.checks,
          { name: 'illustrator_column', ok: false, detail: 'missing', library: 'manga-library' },
        ],
      })
      .expect(200);
    const of = (lib: string) =>
      env.service.checks(Date.now(), null, lib).find((c) => c.name === 'illustrator_column')!;
    expect(of(env.libraryId()).ok).toBe(true);
    expect(of(mangaId())).toMatchObject({ ok: false, detail: 'missing' });
    expect(env.service.checksPass(mangaId()).ok).toBe(false);
    expect(env.service.checksPass(env.libraryId()).ok).toBe(true);
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(auth(apply))
      .send({ ...hb, libraries: ['japanese-library', 'manga-library'] })
      .expect(200);
    env.cleanupDb.prepare(`UPDATE preflight SET ok = 1 WHERE name = 'illustrator_column'`).run();
  });

  it('checks a new copy against the other library: identical or the same text there is recorded, not added', async () => {
    for (const lib of [env.libraryId(), mangaId()]) env.service.arrivals.setMode('analyse', lib);
    env.service.arrivals.requestRun(env.libraryId());
    await steps();
    const run1 = env.cleanupDb
      .prepare('SELECT library_id, state, error FROM calibre_arrival_runs ORDER BY id DESC LIMIT 1')
      .get() as { library_id: string; state: string; error: string | null };
    expect(run1).toMatchObject({ library_id: env.libraryId(), state: 'done' });
    // japanese-library's run: manga-library's C (its bytes) is a copy, D is new.
    expect(outcome('C again.epub')).toEqual({
      outcome: 'identical',
      calibre_id: M.C,
      calibre_library_id: mangaId(),
    });
    expect(outcome('D.epub').outcome).toBe('new');
    // Only its own folders: manga's files wait for manga-library's own run (not even listed).
    expect(outcome('A again.epub')).toBeUndefined();

    env.service.arrivals.requestRun(mangaId());
    await steps();
    const run2 = env.cleanupDb
      .prepare('SELECT library_id, state, error FROM calibre_arrival_runs ORDER BY id DESC LIMIT 1')
      .get() as { library_id: string; state: string; error: string | null };
    expect(run2).toMatchObject({ library_id: mangaId(), state: 'done' });
    expect(outcome('A again.epub')).toEqual({
      outcome: 'identical',
      calibre_id: J.A,
      calibre_library_id: env.libraryId(),
    });
    // B's text in another edition: compared with japanese-library's B by stage 3's rules.
    const b = outcome('B again.epub');
    expect(['duplicate', 'better_review']).toContain(b.outcome);
    expect(b).toMatchObject({ calibre_id: J.B, calibre_library_id: env.libraryId() });
    // Never anything added, and each library keeps its own state and baseline.
    expect(
      env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_batches').get(),
    ).toEqual({
      n: 0,
    });
    const states = env.cleanupDb
      .prepare(
        'SELECT library_id, baseline_at IS NOT NULL AS b FROM calibre_arrivals_state ORDER BY library_id',
      )
      .all() as { library_id: string; b: number }[];
    expect(states.map((s) => s.b)).toEqual([1, 1]);
  }, 120_000);

  it('a book added by hand that copies a book of the other library is review, never removed', async () => {
    // Added by hand to manga-library: japanese-library's A (the same file) and B's text again.
    M.Ahand = await manga.addBook({ title: 'A', authors: ['作者'], epub: A });
    M.Bhand = await manga.addBook({
      title: 'B 完全版',
      authors: ['作者'],
      epub: makeTextEpub({ title: 'B 完全版', chapters: chaptersOf(12) }),
    });
    manga.age();
    await env.indexer.checkLibrary(listLibraries(env.db).find((l) => l.id === mangaId())!);
    env.service.arrivals.requestRun(mangaId());
    await steps();
    const run = env.cleanupDb
      .prepare('SELECT library_id, state, error FROM calibre_arrival_runs ORDER BY id DESC LIMIT 1')
      .get() as { library_id: string; state: string; error: string | null };
    // Past stage 3 (where the books added by hand are compared); it then waits for manga-library's
    // own stage 4, which these books need first.
    expect(run.library_id).toBe(mangaId());
    expect(env.service.arrivals.currentRun()?.p.phase).not.toMatch(
      /^(scan|archives|identify|compare|plan|add|index|stage1|stage3)$/,
    );
    env.service.arrivals.stopRun();
    const reviews = env.cleanupDb
      .prepare(
        `SELECT kind, calibre_id, calibre_library_id, json_extract(detail_json, '$.newId') AS newId
         FROM calibre_arrival_reviews WHERE kind = 'cross_copy' ORDER BY newId`,
      )
      .all() as { kind: string; calibre_id: number; calibre_library_id: string; newId: number }[];
    const byNew = new Map(reviews.map((r) => [r.newId, r]));
    expect(byNew.get(M.Ahand)).toMatchObject({
      calibre_id: J.A,
      calibre_library_id: env.libraryId(),
    });
    expect(byNew.get(M.Bhand)).toMatchObject({
      calibre_id: J.B,
      calibre_library_id: env.libraryId(),
    });
    // Nothing proposed for removal in either library because of the other.
    expect(
      env.cleanupDb
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE field = 'book' AND calibre_id IN (?, ?, ?, ?)`,
        )
        .get(M.Ahand, M.Bhand, J.A, J.B),
    ).toEqual({ n: 0 });
    // The choices: recorded only.
    const id = (
      env.cleanupDb
        .prepare(`SELECT id FROM calibre_arrival_reviews WHERE kind = 'cross_copy' LIMIT 1`)
        .get() as {
        id: number;
      }
    ).id;
    expect(() => env.service.arrivals.decide(id, 'add_new')).toThrow();
    env.service.arrivals.decide(id, 'keep_both');
  }, 120_000);

  it('an add batch names its library; an older sidecar never gets another library’s', async () => {
    const run = Number(
      env.cleanupDb
        .prepare(
          `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json, library_id)
           VALUES ('now', 'on', 'done', 'done', 1, '{}', ?)`,
        )
        .run(mangaId()).lastInsertRowid,
    );
    const file = (
      env.cleanupDb
        .prepare(`SELECT id FROM calibre_arrival_files WHERE rel_path = 'D.epub'`)
        .get() as { id: number }
    ).id;
    expect(env.service.arrivals.addBatches.planAdds(run, mangaId(), [file])).toHaveLength(1);
    // healthyHeartbeat's sidecar reports version 'test' (older than 1.7.0): nothing for it.
    const none = await request(env.app)
      .post('/api/v1/cleanup-apply/arrivals/claim')
      .set(auth(apply))
      .send({});
    expect(none.body.batch).toBeNull();
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(auth(apply))
      .send({
        ...healthyHeartbeat(),
        version: '1.7.0',
        libraries: ['japanese-library', 'manga-library'],
      })
      .expect(200);
    const claim = await request(env.app)
      .post('/api/v1/cleanup-apply/arrivals/claim')
      .set(auth(apply))
      .send({});
    expect(claim.body.batch).toMatchObject({ calibreLibrary: 'manga-library' });
  });
});
