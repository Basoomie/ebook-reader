/**
 * WP20c (stage 3, content duplicates) end to end on a synthetic library, with the reader's
 * real import code (the counter bundle, run in-process): one book per case, Preview (nothing
 * written to Calibre), the classes, the better copy, sets, the gate, then On: the removal
 * batch through stage 1's path (export check, tags, handoff), Undo, your decisions, and the
 * check before a batch.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { getStage } from '../src/cleanup/stages';
import { fingerprint } from './helpers/calibre-fixture';
import { healthyHeartbeat, makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { chaptersOf, fakeText, makeTextEpub, picture } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const iso = (y: number) => `${y}-01-01 00:00:00+00:00`;

describe('stage 3: content duplicates', () => {
  let env: CleanupEnv;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  let user: string;
  let apply: string;
  let refDir: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const made = await makeCleanupEnv({
      service: { stage3Reader: new InProcessReader(bundle, IMPORT), counterBuild: 'test' },
    });
    env = made.env;
    const lo = await Promise.all([picture(1, 600, 40), picture(2, 600, 40)]);
    const hi = await Promise.all([picture(1, 1200, 92), picture(2, 1200, 92)]);
    const mid = [await picture(3, 800, 80)];
    const vol1 = chaptersOf(4);
    const vol2 = chaptersOf(5);
    const ss = fakeText(999, 12_000);
    const c = chaptersOf(3);
    const commentary = c.map(
      (ch, i) => ch.slice(0, 3000) + fakeText(77_000 + i, 1000) + ch.slice(3000),
    );
    const add = (title: string, epub: Buffer, extra: Record<string, unknown> = {}) =>
      env.lib.addBook({ title, authors: ['作者'], epub, ...extra });
    ids = {
      A1: await add(
        'A',
        makeTextEpub({ title: 'A', chapters: chaptersOf(1), images: lo, ruby: true }),
        {
          timestamp: iso(2019),
          tags: ['PeepoHappyBooks'],
        },
      ),
      A2: await add(
        'A',
        makeTextEpub({ title: 'A', chapters: chaptersOf(1), images: hi, ruby: true }),
        {
          timestamp: iso(2021),
        },
      ),
      B1: await add('B', makeTextEpub({ title: 'B', chapters: chaptersOf(2), images: mid })),
      B2: await add(
        'B',
        makeTextEpub({ title: 'B【電子限定SS付】', chapters: [...chaptersOf(2), ss], images: mid }),
      ),
      C1: await add('C', makeTextEpub({ title: 'C', chapters: c })),
      C2: await add('C', makeTextEpub({ title: 'C【電子特別版】', chapters: commentary })),
      V1: await add('V 1', makeTextEpub({ title: 'V 1', chapters: vol1 })),
      V2: await add('V 2', makeTextEpub({ title: 'V 2', chapters: vol2 })),
      O1: await add(
        'V',
        makeTextEpub({ title: '【合本版1-2巻】V', chapters: [...vol1, ...vol2] }),
        {
          timestamp: iso(2018),
        },
      ),
      O2: await add(
        'V',
        makeTextEpub({ title: '【合本版1-2巻】V', chapters: [...vol1, ...vol2] }),
        {
          timestamp: iso(2020),
        },
      ),
      OX: await add('V 全2巻', makeTextEpub({ title: 'V 全2巻', chapters: [...vol1, ...vol2] }), {
        timestamp: iso(2022),
      }),
      S: await add(
        'B 試し読み',
        makeTextEpub({ title: 'B 試し読み', chapters: [chaptersOf(2)[0].slice(0, 3000)] }),
      ),
      BB: await add(
        '『B』BOOK☆WALKER限定書き下ろしショートストーリー',
        makeTextEpub({ title: '『B』BOOK☆WALKER限定書き下ろしショートストーリー', chapters: [ss] }),
      ),
      D1: await add('D', makeTextEpub({ title: 'D', chapters: chaptersOf(6) })),
      D2: await add('D', makeTextEpub({ title: 'D', chapters: chaptersOf(7) })),
      T1: await add(
        'T',
        makeTextEpub({ title: 'T', chapters: chaptersOf(8), images: [await picture(9, 1200, 40)] }),
      ),
      T2: await add(
        'T',
        makeTextEpub({ title: 'T', chapters: chaptersOf(8), images: [await picture(9, 800, 92)] }),
      ),
      H1: await add('H', makeTextEpub({ title: 'H', chapters: chaptersOf(10) })),
      H2: await add('H', makeTextEpub({ title: 'H', chapters: chaptersOf(10), direction: 'ltr' })),
      I1: await add('画集', makeTextEpub({ title: '画集', chapters: ['あ'], images: mid })),
      I2: await add('画集', makeTextEpub({ title: '画集', chapters: ['あ'], images: mid })),
    };
    await made.setup();
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    uuids = {};
    for (const [k, id] of Object.entries(ids)) {
      uuids[k] = (
        mdb.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }
      ).uuid;
    }
    mdb.close();
    user = env.userToken();
    apply = env.applyToken();

    // The gate's files (the labeled books and the measured pairs).
    refDir = path.join(env.dbDir, 'cleanup', 'reference-sample');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(
      path.join(refDir, 'gold800.json'),
      JSON.stringify({
        [ids.S]: { kind: 'sample', fmt: 'light novel' },
        [ids.BB]: { kind: 'bonus', fmt: 'light novel' },
        [ids.O1]: { kind: 'omnibus', fmt: 'light novel' },
        [ids.I1]: { kind: 'full', fmt: 'image-only' },
        [ids.A1]: { kind: 'full', fmt: 'light novel' },
      }),
    );
    const pair = (
      key: string,
      group: string,
      a: number,
      b: number,
      expected: string,
      anchor?: string,
    ) => ({
      key,
      group,
      a,
      b,
      measured: { aInB: 0, bInA: 0 },
      expected,
      ...(anchor ? { anchor } : {}),
    });
    fs.writeFileSync(
      path.join(refDir, 'stage3-pairs.json'),
      JSON.stringify({
        pairs: [
          pair('a', 'bonus_attached', ids.A1, ids.A2, 'duplicate', 'not_spread'),
          pair('b', 'bonus_attached', ids.B1, ids.B2, 'superset'),
          pair('s', 'sample', ids.S, ids.B1, 'never'),
          pair('bb', 'bonus_item', ids.BB, ids.B2, 'never'),
          pair('o', 'omnibus', ids.O1, ids.V1, 'never'),
          pair('c', 'special', ids.C2, ids.C1, 'duplicate', 'spread'),
          pair('d', 'special', ids.D1, ids.D2, 'different'),
        ],
      }),
    );
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        gate: {
          labeledBooksFile: path.join(refDir, 'gold800.json'),
          duplicatePairsFile: path.join(refDir, 'stage3-pairs.json'),
        },
        pacing: { batchSize: 500, maxBatchPercent: 10 },
      })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  /** Waits for the service's own analysis loop (never steps it in parallel). */
  async function settle() {
    for (let i = 0; i < 1200; i++) {
      await env.service.tick();
      const st = getStage(env.cleanupDb, 3).state;
      if (st === 'ready' || st === 'failed') return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('stage 3 analysis did not finish');
  }

  async function analyse(mode: 'analyse' | 'on' = 'analyse') {
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode })
      .expect(200);
    await settle();
    const p = env.service.analysis3!.progress()!;
    expect(p.error).toBeNull();
    expect(p.phase).toBe('done');
    return p;
  }

  const pairOf = async (x: string, y: string) => {
    const res = await request(env.app)
      .get('/api/v1/cleanup/stage3/pairs?view=review&limit=200')
      .set(auth(user));
    const all = [res.body.items];
    for (const view of ['duplicate', 'superset', 'never', 'different', 'keep_both', 'image_only']) {
      all.push(
        (
          await request(env.app)
            .get(`/api/v1/cleanup/stage3/pairs?view=${view}&limit=200`)
            .set(auth(user))
        ).body.items,
      );
    }
    const [a, b] = ids[x] < ids[y] ? [ids[x], ids[y]] : [ids[y], ids[x]];
    return all
      .flat()
      .find(
        (p: { a: { calibreId: number }; b: { calibreId: number } }) =>
          p.a.calibreId === a && p.b.calibreId === b,
      );
  };

  it('Preview: classes, better copies, sets and the gate; nothing written to Calibre', async () => {
    const before = fingerprint(env.root.dir);
    const p = await analyse('analyse');
    expect(fingerprint(env.root.dir)).toEqual(before);
    if (process.env.WP20C_DEBUG) {
      console.log(JSON.stringify(ids));
      for (const r of env.cleanupDb
        .prepare(
          'SELECT calibre_id, chars, samples, kind, kind_by, image_only, image_entries, ruby, toc_entries, vertical, error FROM text_facts',
        )
        .all())
        console.log(JSON.stringify(r));
      for (const r of env.cleanupDb
        .prepare(
          'SELECT a_id,b_id,source,round(est_a_in_b,3) e1,round(est_b_in_a,3) e2,round(a_in_b,3) x,round(b_in_a,3) y,class,rule,keep_id,error FROM content_pairs',
        )
        .all())
        console.log(JSON.stringify(r));
    }
    expect(p.textErrors).toBe(0);
    expect(p.imageOnly).toBe(2);
    expect(p.omnibusByText).toBe(1);

    const a = await pairOf('A1', 'A2');
    expect([a.class, a.keepId]).toEqual(['duplicate', ids.A2]);
    expect(a.best.measures.find((m: { name: string }) => m.name === 'images').winner).toBe('b');
    const b = await pairOf('B1', 'B2');
    expect([b.class, b.keepId, b.container]).toEqual(['superset', ids.B2, 'b']);
    const c = await pairOf('C1', 'C2');
    expect([c.class, c.rule]).toEqual(['review', 'spread_unset']);
    expect(Math.max(c.spread.a.interleavedRuns, c.spread.b.interleavedRuns)).toBe(6);
    expect((await pairOf('V1', 'O1')).rule).toBe('omnibus');
    expect((await pairOf('O1', 'O2')).rule).toBe('omnibus_same');
    expect((await pairOf('O1', 'OX')).class).toBe('duplicate');
    expect((await pairOf('S', 'B1')).rule).toBe('sample');
    expect((await pairOf('BB', 'B2')).rule).toBe('bonus');
    // Different books are measured only because the gate lists them.
    expect(await pairOf('D1', 'D2')).toMatchObject({ source: 'gate', class: 'different' });
    const t = await pairOf('T1', 'T2');
    expect([t.class, t.keepId, t.best.by]).toEqual(['duplicate', null, 'tradeoff']);
    const h = await pairOf('H1', 'H2');
    expect(h.best.measures.find((m: { name: string }) => m.name === 'direction').winner).toBe(
      'tradeoff',
    );
    expect((await pairOf('I1', 'I2')).rule).toBe('image_only');

    const props = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&limit=50')
      .set(auth(user))
      .expect(200);
    const removed = props.body.items
      .map((i: { calibre_id: number }) => i.calibre_id)
      .sort((x: number, y: number) => x - y);
    // The omnibus set keeps its oldest copy (all tied).
    expect(removed).toEqual([ids.A1, ids.B1, ids.O2, ids.OX].sort((x, y) => x - y));
    const a1 = props.body.items.find((i: { calibre_id: number }) => i.calibre_id === ids.A1);
    expect(a1.evidence.kept.uuid).toBe(uuids.A2);
    expect(a1.evidence.removed.customTags).toEqual(['PeepoHappyBooks']);
    // The comparison that chose the copy is in the removal's evidence from the first analysis on.
    expect(
      a1.evidence.stage3.best.measures.find((m: { name: string }) => m.name === 'images').winner,
    ).toBe('b');
    expect(a1.evidence.sha256).toBe(sha(fs.readFileSync(env.lib.epubFile(ids.A1))));

    expect(p.gate!.passed).toBe(true);
    const gate = (await request(env.app).get('/api/v1/cleanup/stage3/gate').set(auth(user))).body
      .gate;
    expect(gate.pairs.asMeasured).toBe(gate.pairs.checked);
    expect(gate.spread.ok).toBe(true);
    expect(gate.kinds).toMatchObject({
      guards: 3,
      recognized: 3,
      imageOnly: 1,
      imageOnlyRecognized: 1,
    });

    const omnibus = (
      await request(env.app).get('/api/v1/cleanup/stage3/books?view=omnibus').set(auth(user))
    ).body;
    expect(omnibus.items.map((x: { calibre_id: number }) => x.calibre_id).sort()).toEqual(
      [ids.O1, ids.O2, ids.OX].sort(),
    );
    const status = (await request(env.app).get('/api/v1/cleanup/status').set(auth(user))).body;
    expect(status.stage3.waiting).toBe('Preview: nothing is changed in Calibre');
    expect(status.stage3.gate.passed).toBe(true);
  }, 120_000);

  it('a decision on a review pair turns into a removal; a re-run adds nothing twice', async () => {
    const t = await pairOf('T1', 'T2');
    await request(env.app)
      .post(`/api/v1/cleanup/stage3/pairs/${t.id}`)
      .set(auth(user))
      .send({ decision: 'remove_b' })
      .expect(200);
    await settle();
    const props = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&limit=50')
      .set(auth(user));
    const t2 = props.body.items.find((i: { calibre_id: number }) => i.calibre_id === ids.T2);
    expect(t2.evidence.stage3.byUser).toBe(true);
    expect(props.body.total).toBe(5);

    await request(env.app).post('/api/v1/cleanup/stages/3/analyse').set(auth(user)).expect(200);
    const p = await analyse('analyse');
    expect(p.textRead).toBe(0); // every file kept from the first analysis
    const again = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&state=proposed&limit=50')
      .set(auth(user));
    expect(again.body.total).toBe(5);
  }, 120_000);

  it('On: one removal batch through stage 1’s path, the handoff and Undo', async () => {
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
      .send(healthyHeartbeat())
      .expect(200);
    const a1Reader = env.readerBook(uuids.A1)!.bookId;
    const a2Reader = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a1Reader);

    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(200);
    const claimBatch = async () => {
      const claim = await request(env.app)
        .post('/api/v1/cleanup-apply/claim')
        .set(auth(apply))
        .expect(200);
      const b = claim.body.batch;
      if (!b) return null;
      const snap = await request(env.app)
        .get(`/api/v1/cleanup-apply/batches/${b.id}/metadata-snapshot`)
        .set(auth(apply))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      await request(env.app)
        .post(`/api/v1/cleanup-apply/batches/${b.id}/snapshot-saved`)
        .set(auth(apply))
        .send({ sha256: sha(snap.body as Buffer) })
        .expect(200);
      return b;
    };
    // Every batch (the batch cap is 10 % of the library's books here).
    const done: { id: string; items: { calibreId: number }[] }[] = [];
    for (let round = 0; round < 10; round++) {
      await env.service.tick();
      expect(getStage(env.cleanupDb, 3).pauseReason).toBeNull();
      const open = env.service.batches.open();
      if (!open) break;
      expect(open.stage).toBe(3);
      expect(env.service.holdsIngest(env.libraryId())).toBe(false);
      const b = await claimBatch();
      expect(b.stage).toBe(3);
      expect(env.service.holdsIngest(env.libraryId())).toBe(true);
      const step = (itemId: number, body: Record<string, unknown>, status = 200) =>
        request(env.app)
          .post(`/api/v1/cleanup-apply/batches/${b.id}/items/${itemId}`)
          .set(auth(apply))
          .send(body)
          .expect(status);
      for (const item of b.items) {
        if (item.calibreId === ids.A1) {
          expect(item.kept.uuid).toBe(uuids.A2);
          expect(item.addTags).toEqual(['PeepoHappyBooks']);
        }
        await step(item.itemId, { step: 'verified' });
        // The export must be the analysed file.
        await step(
          item.itemId,
          { step: 'exported', quarantineDir: `/q/${item.calibreId}`, exportSha256: 'f'.repeat(64) },
          409,
        );
        await step(item.itemId, {
          step: 'exported',
          quarantineDir: `/q/${item.calibreId}`,
          exportSha256: item.sha256,
        });
        await step(item.itemId, { step: 'tagged' });
        env.lib.trashBook(item.calibreId);
        await step(item.itemId, { step: 'removed' });
      }
      await request(env.app)
        .post(`/api/v1/cleanup-apply/batches/${b.id}/finish`)
        .set(auth(apply))
        .send({})
        .expect(200);
      expect(env.service.wantsIngest(env.libraryId())).toBe(true);
      await env.index();
      env.service.batches.checkIngested();
      expect(env.service.batches.get(b.id)!.ingestedAt).not.toBeNull();
      done.push(b);
    }
    expect(done.flatMap((b) => b.items.map((i) => i.calibreId)).sort((x, y) => x - y)).toEqual(
      [ids.A1, ids.B1, ids.O2, ids.OX, ids.T2].sort((x, y) => x - y),
    );
    expect(
      (await request(env.app).get('/api/v1/cleanup/status').set(auth(user))).body.stage3.waiting,
    ).toBe('Done: nothing left to remove');
    // The handoff: A1 held reader data, A2 none: the data-holding reader book now shows A2.
    expect(env.readerBook(uuids.A2)!.bookId).toBe(a1Reader);
    expect(env.readerBook(uuids.A1)!).toEqual({ bookId: a2Reader, missing: true });

    // Undo from Calibre's trash: same ids and UUIDs back, the swap reversed.
    const first = done.find((b) => b.items.some((i) => i.calibreId === ids.A1))!;
    const undo = await request(env.app)
      .post(`/api/v1/cleanup/batches/${first.id}/undo`)
      .set(auth(user))
      .expect(200);
    expect(undo.body.batch.kind).toBe('undo');
    const ub = await claimBatch();
    expect([ub.stage, ub.kind]).toEqual([3, 'undo']);
    for (const item of ub.items) {
      env.lib.trashRestore(item.calibreId);
      await request(env.app)
        .post(`/api/v1/cleanup-apply/batches/${ub.id}/items/${item.itemId}`)
        .set(auth(apply))
        .send({ step: 'restored', method: 'trash', calibreId: item.calibreId, uuid: item.uuid })
        .expect(200);
    }
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${ub.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    expect(env.readerBook(uuids.A1)!.bookId).toBe(a1Reader);
    expect(env.readerBook(uuids.A2)!.bookId).toBe(a2Reader);
    expect(env.service.batches.get(first.id)!.state).toBe('undone');
    await env.index();
    env.service.batches.checkIngested();
    expect(getStage(env.cleanupDb, 3).pauseReason).toBeNull();
    expect(env.readerBook(uuids.A1)).toEqual({ bookId: a1Reader, missing: false });
  }, 120_000);

  it('a copy whose file changed after the analysis pauses the stage; nothing is removed', async () => {
    // Fresh analysis (the undone copies are not proposed again), then edit a kept file.
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'off' })
      .expect(200);
    const extra = await env.lib.addBook({
      title: 'E',
      authors: ['作者'],
      epub: makeTextEpub({ title: 'E', chapters: chaptersOf(20) }),
    });
    const extra2 = await env.lib.addBook({
      title: 'E',
      authors: ['作者'],
      epub: makeTextEpub({ title: 'E', chapters: chaptersOf(20), ruby: true }),
    });
    await env.index();
    await request(env.app).post('/api/v1/cleanup/stages/3/analyse').set(auth(user)).expect(200);
    const p = await analyse('analyse');
    const props = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&state=proposed&limit=50')
      .set(auth(user));
    expect(props.body.items.map((i: { calibre_id: number }) => i.calibre_id)).toEqual([extra]);
    expect(p.gate!.problems).toEqual([]);
    expect(p.gate!.pairs).toMatchObject({ checked: 7, asMeasured: 7 });
    // The copy to keep gets another file before stage 3 is switched on.
    fs.writeFileSync(
      env.lib.epubFile(extra2),
      makeTextEpub({ title: 'E', chapters: chaptersOf(21), ruby: true }),
    );
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(200);
    await env.service.tick();
    const stage = getStage(env.cleanupDb, 3);
    expect(stage.pauseReason).toBe('not_identical');
    expect(stage.pauseDetail).toMatch(/files changed since the analysis/);
    expect(env.service.batches.open()).toBeNull();
    const left = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&limit=50')
      .set(auth(user));
    const e = left.body.items.find((i: { calibre_id: number }) => i.calibre_id === extra);
    expect([e.state, e.review_reason]).toEqual([
      'skipped',
      "A copy's file changed since the analysis",
    ]);
    expect(fs.existsSync(env.lib.epubFile(extra))).toBe(true);
  }, 120_000);

  it("a preview whose marker stage 2 took out of Calibre's title is still a preview", async () => {
    await request(env.app).post('/api/v1/cleanup/stages/3/resume').set(auth(user)).expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'off' })
      .expect(200);
    // The file and Calibre say "P"; stage 2's undo record keeps Calibre's earlier title.
    const pv = await env.lib.addBook({
      title: 'P',
      authors: ['作者'],
      epub: makeTextEpub({ title: 'P', chapters: [chaptersOf(2)[0].slice(3000, 6000)] }),
    });
    await env.index();
    const uuid = (
      new Database(env.lib.dbFile, { readonly: true })
        .prepare('SELECT uuid FROM books WHERE id = ?')
        .get(pv) as {
        uuid: string;
      }
    ).uuid;
    const lib = env.libraryId();
    env.cleanupDb
      .prepare(
        `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at)
         VALUES ('old-stage2', 2, ?, 'apply', 'applied', 1, 1, 1)`,
      )
      .run(lib);
    const change = env.cleanupDb
      .prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
           source, class, state, created_at, updated_at)
         VALUES (2, ?, ?, ?, 'title', '"P【試し読み】"', '"P"', 'file', 'auto', 'applied', 1, 1)`,
      )
      .run(lib, pv, uuid).lastInsertRowid;
    env.cleanupDb
      .prepare(
        `INSERT INTO field_undo (batch_id, change_id, library_id, calibre_id, calibre_uuid, field, old_json,
           new_json, created_at) VALUES ('old-stage2', ?, ?, ?, ?, 'title', '"P【試し読み】"', '"P"', 1)`,
      )
      .run(change, lib, pv, uuid);
    await request(env.app).post('/api/v1/cleanup/stages/3/analyse').set(auth(user)).expect(200);
    await analyse('analyse');
    const pb = await request(env.app)
      .get('/api/v1/cleanup/stage3/pairs?view=never&limit=200')
      .set(auth(user));
    const pair = pb.body.items.find(
      (x: { a: { calibreId: number }; b: { calibreId: number } }) =>
        x.a.calibreId === pv || x.b.calibreId === pv,
    );
    expect(pair?.rule).toBe('sample');
    const props = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=3&state=proposed&limit=50')
      .set(auth(user));
    expect(props.body.items.map((i: { calibre_id: number }) => i.calibre_id)).not.toContain(pv);
  }, 120_000);
});
