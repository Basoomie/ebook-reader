/**
 * Replaced books (inherit/): a new arrival kept over a library book of the same text gets the
 * old record's values it lacks: the rules (never a value the copy has, store ids only added,
 * never a field that is the user's, custom tags only), and the pass through the stages' field
 * batches with the real apply sidecar and the stand-in calibredb (what the cleanup knew of each
 * value comes with it, review items Calibre now answers are closed, Undo, a run's own pairs).
 */
import Database from 'better-sqlite3';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { inheritChanges, mergeInherit, type InheritValues } from '../src/cleanup/inherit/rules';
import { TWO_VALUES_REASON } from '../src/cleanup/stage2-batches';
import { INHERIT_ANALYSIS, InheritPass } from '../src/cleanup/inherit/pass';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { addStage2Tables, calibreRecord, makeMetaEpub } from './helpers/stage2-fixture';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const PASSWORD = 'calibre-test-password';
const quiet = { info: () => {}, error: () => {} };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (s: http.Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );

const values = (p: Partial<InheritValues> = {}): InheritValues => ({
  series: { name: null, index: null },
  identifiers: {},
  publisher: null,
  languages: [],
  illustrator: [],
  tags: [],
  ...p,
});

describe('replaced books: the rules', () => {
  it('gives only what the kept copy lacks; store ids only added; custom tags only', () => {
    const old = values({
      series: { name: '薬屋のひとりごと', index: 1 },
      identifiers: { amazon_jp: 'B0OLD', isbn: '978', bookmeter: '1' },
      publisher: '主婦の友社',
      languages: ['jpn'],
      illustrator: ['しのとうこ'],
      tags: ['ミステリー', '22ARead'],
    });
    const kept = values({ identifiers: { bookmeter: '2', bookwalker: 'bw' } });
    const changes = inheritChanges(old, kept, ['22*']);
    expect(changes).toEqual([
      {
        field: 'series',
        stage: 4,
        before: { name: null, index: null },
        value: { name: '薬屋のひとりごと', index: 1 },
      },
      {
        field: 'identifiers',
        stage: 4,
        before: { bookmeter: '2', bookwalker: 'bw' },
        // The copy's own bookmeter id stays; the old record's other ids are added.
        value: { bookmeter: '2', bookwalker: 'bw', amazon_jp: 'B0OLD', isbn: '978' },
      },
      { field: 'publisher', stage: 2, before: null, value: '主婦の友社' },
      { field: 'languages', stage: 2, before: [], value: ['jpn'] },
      { field: 'illustrator', stage: 4, before: [], value: ['しのとうこ'] },
      // A genre is stage 5's decision for the copy; the user's own tag comes along.
      { field: 'tags', stage: 5, before: [], value: { add: ['22ARead'], remove: [] } },
    ]);
  });

  it('never replaces a value the kept copy has, and never a field that is the user’s', () => {
    const old = values({ series: { name: '旧', index: 3 }, publisher: 'A' });
    const kept = values({ series: { name: '新', index: 2 } });
    expect(inheritChanges(old, kept, [], new Set(['publisher']))).toEqual([]);
    expect(inheritChanges(values(), values({ publisher: 'B' }), [])).toEqual([]);
  });

  it('one copy that replaced two books: one change per field; disagreements go to review', () => {
    const a = values({
      series: { name: 'S', index: 1 },
      identifiers: { amazon_jp: 'B0A', isbn: '1' },
      publisher: 'P',
    });
    const b = values({
      series: { name: 'S', index: 2 },
      identifiers: { amazon_jp: 'B0A', isbn: '2', google: 'g' },
      publisher: 'P',
    });
    const out = mergeInherit([a, b], values({ identifiers: { bookmeter: '9' } }), []);
    expect(out.map((c) => c.field)).toEqual(['series', 'identifiers', 'publisher']);
    // The isbn the two disagree on is left out; the rest is pooled.
    expect(out[1]).toMatchObject({
      value: { bookmeter: '9', amazon_jp: 'B0A', google: 'g' },
      conflict: null,
    });
    expect(out[0].conflict).toMatch(/different values/);
    expect(out[2]).toMatchObject({ value: 'P', conflict: null, from: 0 });
  });
});

describe('replaced books: the pass', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let url: string;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  let pass: InheritPass;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    const book = (title: string, extra: Record<string, unknown> = {}) =>
      env.lib.addBook({
        title,
        authors: ['作者'],
        cover: 'none',
        epub: makeMetaEpub({ title, creators: [{ name: '作者', role: 'aut' }] }),
        ...extra,
      });
    ids = {
      OLD: await book('薬屋のひとりごと', {
        series: { name: '薬屋のひとりごと', index: 1 },
        publisher: '主婦の友社',
      }),
      KEPT: await book('薬屋のひとりごと'),
      // A second library copy the same new copy replaced (same series, one more store id).
      OLD3: await book('薬屋のひとりごと', { series: { name: '薬屋のひとりごと', index: 1 } }),
      // A second replacement whose kept copy already has a series of its own.
      OLD2: await book('別の本', { series: { name: '旧シリーズ', index: 3 } }),
      KEPT2: await book('別の本', { series: { name: '新シリーズ', index: 2 } }),
    };
    for (let i = 0; i < 20; i++) await book(`棚の本 ${i}`);
    const meta = new Database(path.join(env.lib.dir, 'metadata.db'));
    const ident = meta.prepare('INSERT INTO identifiers (book, type, val) VALUES (?, ?, ?)');
    ident.run(ids.OLD, 'amazon_jp', 'B0OLD');
    ident.run(ids.OLD, 'bookmeter', '111');
    ident.run(ids.KEPT, 'bookmeter', '222');
    ident.run(ids.OLD3, 'amazon_jp', 'B0OLD');
    ident.run(ids.OLD3, 'isbn', '9784');
    uuids = Object.fromEntries(
      Object.entries(ids).map(([k, id]) => [
        k,
        (meta.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }).uuid,
      ]),
    );
    meta.close();
    await made.setup();
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    url = `http://127.0.0.1:${await listen(server)}`;
    const cport = await listen(calibreServer);
    const user = env.userToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        pacing: {
          itemDelaySeconds: 0,
          batchSize: 500,
          maxBatchPercent: 10,
          readMbPerSecond: 0,
          lookupChunk: 2,
        },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
    const lib = env.libraryId();
    const db = env.cleanupDb;
    // The old record's series was the cleanup's (stage 4 wrote it as a best guess); its publisher
    // was Calibre's own.
    const old4 = Number(
      db
        .prepare(
          `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
             source, evidence_json, class, state, analysis_id, created_at, updated_at)
           VALUES (4, ?, ?, ?, 'series', 'null', ?, 'models', '{"unconfirmed":true}', 'auto', 'applied', 'a4', 1, 1)`,
        )
        .run(lib, ids.OLD, uuids.OLD, JSON.stringify({ name: '薬屋のひとりごと', index: 1 }))
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO applied_values (library_id, calibre_uuid, field, value_json, source, batch_id, applied_at, change_id)
       VALUES (?, ?, 'series', ?, 'models', 'b-old', 1, ?)`,
    ).run(lib, uuids.OLD, JSON.stringify({ name: '薬屋のひとりごと', index: 1 }), old4);
    // Run 7 kept the new copies over the old records (stage 3 removals, applied).
    db.prepare(
      `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at)
       VALUES ('b-run7', 3, ?, 'apply', 'applied', 2, 1, 1)`,
    ).run(lib);
    for (const [o, k] of [
      ['OLD', 'KEPT'],
      ['OLD3', 'KEPT'],
      ['OLD2', 'KEPT2'],
    ]) {
      const change = Number(
        db
          .prepare(
            `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
               source, evidence_json, class, state, analysis_id, created_at, updated_at)
             VALUES (3, ?, ?, ?, 'book', '"present"', '"removed"', 'stage3:text', ?, 'auto', 'applied', 'arrivals:7', 1, 1)`,
          )
          .run(
            lib,
            ids[o],
            uuids[o],
            JSON.stringify({ kept: { calibreId: ids[k], uuid: uuids[k] } }),
          ).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO undo_records (batch_id, change_id, library_id, removed_calibre_id, removed_uuid,
           kept_calibre_id, kept_uuid, created_at) VALUES ('b-run7', ?, ?, ?, ?, ?, ?, 1)`,
      ).run(change, lib, ids[o], uuids[o], ids[k], uuids[k]);
      db.prepare(
        `INSERT OR IGNORE INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at, run_id)
         VALUES (?, ?, ?, 'import', 1, 7)`,
      ).run(lib, ids[k], uuids[k]);
    }
    // The run's own series step held the copy's series as a best guess (review).
    db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, 'series', 'null', ?, 'series', '{}', 'review', 'A best guess: listed, not written',
         'proposed', 'arrivals:10', 1, 1)`,
    ).run(lib, ids.KEPT, uuids.KEPT, JSON.stringify({ name: '薬屋のひとりごと', index: 1 }));
    // Calibre's trash: the old records are gone from the library; the reader keeps their records.
    env.lib.removeBook(ids.OLD);
    env.lib.removeBook(ids.OLD2);
    env.lib.removeBook(ids.OLD3);
    await env.index();
    pass = new InheritPass(
      {
        db,
        main: env.db,
        batches: env.service.batches,
        writeWait: () => (env.service.batches.open() ? 'A batch is being applied' : null),
      },
      lib,
    );
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker() {
    const config: SidecarConfig = {
      serverUrl: url,
      token: env.applyToken(),
      quarantineDir: makeTempDir('quarantine'),
      calibredb: process.execPath,
      minFreeMb: 1,
      calibredbTimeoutSeconds: 60,
      checkSeconds: 3600,
      requestTimeoutSeconds: 10,
      trashRestoreWaitSeconds: 3,
      removeWaitSeconds: 3,
      waitPollSeconds: 0.1,
      writeWaitSeconds: 2,
      coverTmpDir: makeTempDir('covers'),
    };
    const calibredb = new Calibredb({
      program: process.execPath,
      prefixArgs: [FAKE],
      timeoutMs: 60_000,
      env: {
        FAKE_CALIBRE_LIBRARY: env.lib.dir,
        FAKE_PASSWORD: PASSWORD,
        FAKE_VERSION: '9.18.0',
        FAKE_ILLUSTRATOR: '1',
      },
      helper: null,
    });
    return new Worker({ config, calibredb, log: quiet, retryMinMs: 20, retryMaxMs: 100 });
  }

  async function drain(w: Worker) {
    for (let round = 0; round < 10; round++) {
      const r = await pass.step();
      for (let i = 0; i < 20; i++) {
        const c = await w.cycle();
        if (c === 'idle' && !env.service.batches.open()) break;
      }
      if (r === 'idle') return;
    }
  }

  const series = (id: number) => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return db
        .prepare(
          'SELECT s.name, b.series_index AS idx FROM books b LEFT JOIN books_series_link l ON l.book = b.id LEFT JOIN series s ON s.id = l.series WHERE b.id = ?',
        )
        .get(id);
    } finally {
      db.close();
    }
  };

  it('Preview lists; On writes what the kept copy lacks, with what the cleanup knew of it', async () => {
    expect(pass.state().mode).toBe('analyse');
    expect(await pass.step()).toBe('more');
    expect(await pass.step()).toBe('idle');
    const proposed = env.cleanupDb
      .prepare(
        `SELECT calibre_id, field, stage, state FROM proposed_changes WHERE analysis_id = ? ORDER BY calibre_id, field`,
      )
      .all(INHERIT_ANALYSIS);
    expect(proposed).toEqual([
      { calibre_id: ids.KEPT, field: 'identifiers', stage: 4, state: 'proposed' },
      { calibre_id: ids.KEPT, field: 'publisher', stage: 2, state: 'proposed' },
      { calibre_id: ids.KEPT, field: 'series', stage: 4, state: 'proposed' },
    ]);
    // Nothing written in Preview.
    expect(calibreRecord(env.lib, ids.KEPT)!.identifiers).toEqual({ bookmeter: '222' });
    expect(pass.view().books).toEqual({ proposed: 2, nothing: 1 });

    pass.setMode('on');
    await drain(worker());
    const kept = calibreRecord(env.lib, ids.KEPT)!;
    expect(kept.identifiers).toEqual({ bookmeter: '222', amazon_jp: 'B0OLD', isbn: '9784' });
    expect(kept.publisher).toBe('主婦の友社');
    expect(series(ids.KEPT)).toEqual({ name: '薬屋のひとりごと', idx: 1 });
    // The copy that had its own series keeps it.
    expect(series(ids.KEPT2)).toEqual({ name: '新シリーズ', idx: 2 });
    const applied = Object.fromEntries(
      (
        env.cleanupDb
          .prepare('SELECT field, source, batch_id FROM applied_values WHERE calibre_uuid = ?')
          .all(uuids.KEPT) as { field: string; source: string; batch_id: string }[]
      ).map((a) => [a.field, a]),
    );
    // The series was the cleanup's best guess on the old record: so it is on the copy.
    expect(applied.series).toMatchObject({ source: 'models', batch_id: 'b-old' });
    const guess = env.cleanupDb
      .prepare(
        `SELECT json_extract(c.evidence_json, '$.unconfirmed') AS g FROM applied_values a
         JOIN proposed_changes c ON c.id = a.change_id WHERE a.calibre_uuid = ? AND a.field = 'series'`,
      )
      .get(uuids.KEPT) as { g: number };
    expect(guess.g).toBe(1);
    // The publisher was Calibre's own: no record of a cleanup write.
    expect(applied.publisher).toBeUndefined();
    expect(applied.identifiers).toMatchObject({ source: 'inherit' });
    // The run's review item for the same series is answered.
    expect(
      env.cleanupDb
        .prepare(`SELECT state FROM proposed_changes WHERE analysis_id = 'arrivals:10'`)
        .get(),
    ).toEqual({ state: 'skipped' });
    expect(pass.counts()).toEqual({ applied: 3 });

    // Undo of the batch puts the copy back as it was.
    const batches = env.cleanupDb
      .prepare(
        `SELECT id FROM batches WHERE kind = 'apply' AND stage IN (2, 4) AND id <> 'b-run7' ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as { id: string }[];
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) {
      await env.service.batches.undo(b.id);
      for (let i = 0; i < 20; i++) {
        const c = await worker().cycle();
        if (c === 'idle' && !env.service.batches.open()) break;
      }
    }
    expect(calibreRecord(env.lib, ids.KEPT)!.identifiers).toEqual({ bookmeter: '222' });
    expect(series(ids.KEPT)).toEqual({ name: null, idx: 1 });
    expect(
      env.cleanupDb
        .prepare(
          `SELECT COUNT(*) AS n FROM applied_values WHERE calibre_uuid = ? AND field = 'series'`,
        )
        .get(uuids.KEPT),
    ).toEqual({ n: 0 });
  });

  it('once: a copy whose changes the write refused as two of one field is looked at again', async () => {
    await pass.step();
    const db = env.cleanupDb;
    db.prepare(
      `UPDATE proposed_changes SET state = 'skipped', review_reason = ? WHERE analysis_id = ? AND calibre_id = ?`,
    ).run(TWO_VALUES_REASON, INHERIT_ANALYSIS, ids.KEPT);
    // As live: the refused changes are there before the deploy's first step.
    db.prepare(
      `UPDATE calibre_inherit_state SET progress_json = json_remove(progress_json, '$.regrouped')`,
    ).run();
    expect(await pass.step()).toBe('more');
    const again = db
      .prepare(
        `SELECT field, state FROM proposed_changes WHERE analysis_id = ? AND calibre_id = ? ORDER BY field`,
      )
      .all(INHERIT_ANALYSIS, ids.KEPT);
    expect(again).toEqual([
      { field: 'identifiers', state: 'proposed' },
      { field: 'publisher', state: 'proposed' },
      { field: 'series', state: 'proposed' },
    ]);
    // Done once.
    db.prepare(
      `UPDATE proposed_changes SET state = 'skipped', review_reason = ? WHERE analysis_id = ? AND calibre_id = ?`,
    ).run(TWO_VALUES_REASON, INHERIT_ANALYSIS, ids.KEPT);
    await pass.step();
    expect(pass.counts()).toEqual({ skipped: 3 });
  });

  it('a run asks for its own replacements only, and only when the pass is On', async () => {
    expect(await pass.forRun(7)).toBeNull();
    expect(pass.counts()).toEqual({});
    pass.setMode('on');
    expect(await pass.forRun(8)).toBeNull();
    expect(pass.counts()).toEqual({});
    expect(await pass.forRun(7)).toBe('Writing the values the replaced books had');
    const w = worker();
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 20; j++) {
        const c = await w.cycle();
        if (c === 'idle' && !env.service.batches.open()) break;
      }
      if ((await pass.forRun(7)) === null) break;
    }
    expect(pass.counts()).toEqual({ applied: 3 });
    expect(series(ids.KEPT)).toEqual({ name: '薬屋のひとりごと', idx: 1 });
  });
});
