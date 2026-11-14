/**
 * WP20b: stage 2 end to end on a synthetic library — the analysis (Look only writes nothing),
 * the gate on labeled books with its per-field pause, planning re-checks, and the real apply
 * sidecar (apps/cleanup-apply) with the stand-in calibredb writing the fields, the cover and
 * Undo, through a real storage server on a local port.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb, buildArgs } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { listFieldPauses } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { fingerprint, makeJpeg } from './helpers/calibre-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import {
  addStage2Tables,
  calibreRecord,
  coverImage,
  editInCalibre,
  makeMetaEpub,
  setStage2Fields,
} from './helpers/stage2-fixture';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const PASSWORD = 'calibre-test-password';
const quiet = { info: () => {}, error: () => {} };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (s: http.Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );

describe('stage 2: metadata and covers from the files', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let log: string;
  let user: string;
  let apply: string;
  let goldFile: string;
  let ids: Record<string, number>;
  let oldCoverB2: Buffer;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    oldCoverB2 = await makeJpeg(10);
    ids = {
      // Calibre's author is "Unknown" (the Google-era import left junk titles).
      B1: await env.lib.addBook({
        title: 'b1-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({
          title: '本の題名 1【電子特典付き】',
          creators: [
            { name: '山田 太郎', role: 'aut' },
            { name: '絵師', role: 'aut' },
          ],
          publisher: 'ＫＡＤＯＫＡＷＡ',
          language: 'ja',
          identifiers: [{ value: 'urn:uuid:1' }, { value: 'B0AAAAAAAA', scheme: 'ASIN' }],
          cover: { data: await coverImage(800, 1200, 1) },
        }),
      }),
      // metadata-processed: Calibre's values came from the Google run; its cover is another picture.
      B2: await env.lib.addBook({
        title: 'Googleの題名',
        authors: ['Google Author'],
        tags: ['metadata-processed'],
        cover: 'jpeg',
        coverHue: 10,
        epub: makeMetaEpub({
          title: '正しい題名',
          creators: [{ name: '佐藤 花子', role: 'aut', refines: true }],
          cover: { data: await coverImage(600, 900, 2) },
        }),
      }),
      // Calibre and the file agree: normalization only.
      B3: await env.lib.addBook({
        title: '魔女の旅々２０',
        authors: ['榊 一郎'],
        cover: 'none',
        epub: makeMetaEpub({ title: '魔女の旅々 20', creators: [{ name: '榊一郎', role: 'aut' }] }),
      }),
      // Calibre has its own title and author: review.
      B4: await env.lib.addBook({
        title: 'まったく別の本',
        authors: ['別人'],
        cover: 'none',
        epub: makeMetaEpub({ title: '本の題名', creators: [{ name: '著者', role: 'aut' }] }),
      }),
      // The user edits this one after the analysis.
      B5: await env.lib.addBook({
        title: 'b5-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({ title: '五冊目', creators: [{ name: '五 郎', role: 'aut' }] }),
      }),
      // A Latin name Calibre already knows in another case (D4).
      B6: await env.lib.addBook({
        title: 'b6-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({ title: 'English Book', creators: [{ name: 'abc def', role: 'aut' }] }),
      }),
      B7: await env.lib.addBook({
        title: 'Other Book',
        authors: ['Abc Def'],
        cover: 'none',
        epub: makeMetaEpub({ title: 'Other Book', creators: [{ name: 'Abc Def', role: 'aut' }] }),
      }),
      // An illustrator credited with role ill.
      B8: await env.lib.addBook({
        title: 'b8-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({
          title: '挿絵のある本',
          creators: [
            { name: '作家', role: 'aut' },
            { name: '画家 一', role: 'ill' },
          ],
        }),
      }),
    };
    for (let i = 0; i < 22; i++) {
      await env.lib.addBook({
        title: `棚の本 ${i}`,
        authors: ['棚の作者'],
        cover: 'none',
        epub: makeMetaEpub({ title: `棚の本 ${i}`, creators: [{ name: '棚の作者', role: 'aut' }] }),
      });
    }
    setStage2Fields(env.lib, ids.B1, { identifiers: { isbn: '9780000000002' } });
    await made.setup();
    // The labeled books (ids as in gold800.json) with the right answers.
    goldFile = path.join(makeTempDir('gold'), 'gold800.json');
    fs.writeFileSync(
      goldFile,
      JSON.stringify({
        [ids.B1]: { t: '本の題名 1', au: ['山田太郎'] },
        [ids.B2]: { t: '正しい題名', au: ['佐藤花子'] },
        [ids.B3]: { t: '魔女の旅々 20', au: ['榊一郎'] },
        [ids.B8]: { t: '挿絵のある本', au: ['作家'], il: ['画家一'] },
      }),
    );
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    (env as unknown as { url: string }).url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    log = path.join(makeTempDir('log'), 'calls.log');
    user = env.userToken();
    apply = env.applyToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        pacing: { itemDelaySeconds: 0, batchSize: 500, maxBatchPercent: 10 },
        stage2: {
          filesPerSecond: 0,
          itemDelaySeconds: 0,
          chunkSize: 2,
          gateMinBooks: 1,
          referenceFile: goldFile,
        },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker(
    extra: { setTimeout?: 'after' | 'never'; wait?: number; fetchImpl?: typeof fetch } = {},
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
      writeWaitSeconds: extra.wait ?? 2,
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
        FAKE_LOG: log,
        FAKE_TIMES: `${log}.times`,
        FAKE_SET_TIMEOUT: extra.setTimeout ?? '',
      },
    });
    return new Worker({
      config,
      calibredb,
      log: quiet,
      retryMinMs: 20,
      retryMaxMs: 100,
      fetchImpl: extra.fetchImpl,
    });
  }

  async function setMode(mode: 'analyse' | 'on') {
    await request(env.app)
      .put('/api/v1/cleanup/stages/2')
      .set(auth(user))
      .send({ mode })
      .expect(200);
    for (let i = 0; i < 300 && getStage(env.cleanupDb, 2).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getStage(env.cleanupDb, 2).state).toBe('ready');
  }

  async function runAll(w: Worker, rounds = 30) {
    for (let i = 0; i < rounds; i++) {
      await env.service.tick();
      const r = await w.cycle();
      await env.index();
      await env.service.tick();
      if (r === 'idle' && !env.service.batches.open() && !env.service.batches.awaitingIngest()) {
        const left = env.service.stage2BooksLeft(env.libraryId());
        if (left === 0 || (await env.service.batches.open()) === null) {
          if (left === 0) return;
        }
      }
    }
  }

  const proposals = (field?: string) =>
    env.cleanupDb
      .prepare(
        `SELECT * FROM proposed_changes WHERE stage = 2 ${field ? 'AND field = ?' : ''} ORDER BY calibre_id, id`,
      )
      .all(...(field ? [field] : [])) as {
      calibre_id: number;
      field: string;
      class: string;
      source: string;
      state: string;
      new_json: string;
      review_reason: string | null;
    }[];
  const setCalls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
          .filter((a) => a[0] === 'set_metadata')
      : [];

  it('Look only reads every EPUB, proposes per field and class, scores the gate, and writes nothing to Calibre', async () => {
    const before = fingerprint(env.lib.dir);
    await setMode('analyse');
    const p = getStage(env.cleanupDb, 2).progress as Record<string, any>;
    expect(p.readDone).toBe(30);
    expect(p.readErrors).toBe(0);
    expect(p.groups.title).toMatchObject({ unknown: 4, processed: 1 });
    const title = proposals('title');
    expect(title.find((r) => r.calibre_id === ids.B1)).toMatchObject({
      class: 'auto',
      source: 'file-unconfirmed',
      new_json: '"本の題名 1"',
    });
    expect(title.find((r) => r.calibre_id === ids.B3)).toMatchObject({
      class: 'auto',
      source: 'normalize',
      new_json: '"魔女の旅々20"',
    });
    expect(title.find((r) => r.calibre_id === ids.B4)).toMatchObject({ class: 'review' });
    expect(proposals('authors').find((r) => r.calibre_id === ids.B6)?.new_json).toBe('["Abc Def"]');
    expect(proposals('authors').some((r) => r.calibre_id === ids.B7)).toBe(false);
    expect(
      proposals('cover')
        .map((r) => r.calibre_id)
        .sort(),
    ).toEqual([ids.B1, ids.B2].sort());
    expect(JSON.parse(proposals('identifiers')[0].new_json)).toEqual({
      isbn: '9780000000002',
      amazon_jp: 'B0AAAAAAAA',
    });
    expect(proposals('illustrator')[0].new_json).toBe('["画家一"]');
    // The gate passes on the labeled books.
    const gate = (getStage(env.cleanupDb, 2).precision as any).gate;
    expect(gate.labeled).toBe(4);
    expect(gate.fields.title.ok).toBe(true);
    expect(gate.fields.authors.ok).toBe(true);
    expect(listFieldPauses(env.cleanupDb, 2)).toEqual([]);
    // Nothing was written anywhere in the library, and nothing was planned.
    expect(fingerprint(env.lib.dir)).toEqual(before);
    expect(env.service.batches.list()).toEqual([]);
    // A second analysis reads no file again (each EPUB's evidence is kept).
    await request(env.app).post('/api/v1/cleanup/stages/2/analyse').set(auth(user)).expect(200);
    for (let i = 0; i < 300 && getStage(env.cleanupDb, 2).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((getStage(env.cleanupDb, 2).progress as any).filesRead).toBe(0);
    const status = await request(env.app).get('/api/v1/cleanup/status').set(auth(user)).expect(200);
    expect(status.body.stage2.waiting).toBe('Preview: nothing is changed in Calibre');
  });

  it('On: the sidecar writes each book in one call; Undo puts the old values and the old cover back', async () => {
    await setMode('on');
    const w = worker();
    await runAll(w);
    const b1 = calibreRecord(env.lib, ids.B1)!;
    expect(b1).toMatchObject({
      title: '本の題名 1',
      sort: '本の題名 1',
      authors: ['山田太郎'],
      // author_sort sent empty: computed from the new name (D5), not the stale "Unknown".
      authorSort: '山田太郎',
      identifiers: { isbn: '9780000000002', amazon_jp: 'B0AAAAAAAA' },
      publisher: 'KADOKAWA',
      languages: ['jpn'],
      hasCover: true,
    });
    // The folder moved with the new title/author (like calibre), and the reader follows it.
    expect(b1.path).not.toMatch(/^Author /);
    expect(fs.existsSync(path.join(env.lib.dir, ...b1.path.split('/'), 'cover.jpg'))).toBe(true);
    const b2 = calibreRecord(env.lib, ids.B2)!;
    expect(b2).toMatchObject({ title: '正しい題名', authors: ['佐藤花子'] });
    // Calibre's old cover was kept in the quarantine before it was replaced.
    const kept = fs
      .readdirSync(quarantine, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('old-cover.jpg'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantine, kept[0])).equals(oldCoverB2)).toBe(true);
    expect(calibreRecord(env.lib, ids.B3)).toMatchObject({
      title: '魔女の旅々20',
      authors: ['榊一郎'],
    });
    // Review: untouched.
    expect(calibreRecord(env.lib, ids.B4)).toMatchObject({
      title: 'まったく別の本',
      authors: ['別人'],
    });
    // Calibre's spelling of a known name; the other book keeps its author (no shared rename).
    expect(calibreRecord(env.lib, ids.B6)!.authors).toEqual(['Abc Def']);
    expect(calibreRecord(env.lib, ids.B7)!.authors).toEqual(['Abc Def']);
    expect(calibreRecord(env.lib, ids.B8)!.illustrators).toEqual(['画家一']);
    // One set_metadata per book, never tags, never an OPF.
    const calls = setCalls();
    expect(calls.length).toBe(new Set(calls.map((c) => c[c.indexOf('--password') + 2])).size);
    for (const c of calls) {
      expect(c.some((a) => a.startsWith('tags:'))).toBe(false);
      expect(c).not.toContain('-m');
    }
    // Every applied value records its source and the last_modified after the write.
    const applied = env.cleanupDb
      .prepare('SELECT field, source, last_modified_after FROM applied_values')
      .all() as {
      field: string;
      source: string;
      last_modified_after: string | null;
    }[];
    expect(applied.length).toBeGreaterThan(10);
    expect(applied.every((a) => a.last_modified_after)).toBe(true);
    expect(new Set(applied.map((a) => a.source))).toEqual(
      new Set(['file-unconfirmed', 'file', 'normalize']),
    );
    // The reader took in the new titles.
    const b1uuid = (
      env.cleanupDb
        .prepare('SELECT calibre_uuid FROM proposed_changes WHERE calibre_id = ? LIMIT 1')
        .get(ids.B1) as {
        calibre_uuid: string;
      }
    ).calibre_uuid;
    const readerTitle = env.db
      .prepare(
        'SELECT b.title FROM books b JOIN book_sources s ON s.book_id = b.id WHERE s.calibre_uuid = ?',
      )
      .get(b1uuid) as { title: string };
    expect(readerTitle.title).toBe('本の題名 1');

    // Undo every batch, newest first.
    const batches = env.service.batches.list().filter((b) => b.kind === 'apply' && b.stage === 2);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      await request(env.app)
        .post(`/api/v1/cleanup/batches/${b.id}/undo`)
        .set(auth(user))
        .expect(200);
      await runAll(w);
      expect(env.service.batches.get(b.id)!.state).toBe('undone');
    }
    expect(calibreRecord(env.lib, ids.B1)).toMatchObject({
      title: 'b1-scan',
      sort: 'b1-scan',
      authors: ['Unknown'],
      authorSort: 'Unknown',
      identifiers: { isbn: '9780000000002' },
      publisher: null,
      languages: [],
      // The cover from the book's own file stays (D3).
      hasCover: true,
    });
    const b2back = calibreRecord(env.lib, ids.B2)!;
    expect(b2back).toMatchObject({ title: 'Googleの題名', authors: ['Google Author'] });
    expect(
      fs
        .readFileSync(path.join(env.lib.dir, ...b2back.path.split('/'), 'cover.jpg'))
        .equals(oldCoverB2),
    ).toBe(true);
    expect(calibreRecord(env.lib, ids.B3)).toMatchObject({
      title: '魔女の旅々２０',
      authors: ['榊 一郎'],
    });
    expect(calibreRecord(env.lib, ids.B8)!.illustrators).toEqual([]);
    const coverUndo = env.cleanupDb
      .prepare(`SELECT restore_detail FROM field_undo WHERE field = 'cover' AND calibre_id = ?`)
      .get(ids.B1) as { restore_detail: string };
    expect(coverUndo.restore_detail).toContain("can't remove a cover");
    expect(env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM applied_values').get()).toEqual({
      n: 0,
    });
    // Undone fields are not proposed again by a new analysis.
    await request(env.app).post('/api/v1/cleanup/stages/2/analyse').set(auth(user)).expect(200);
    for (let i = 0; i < 300 && getStage(env.cleanupDb, 2).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(env.service.stage2BooksLeft(env.libraryId())).toBe(0);
  });

  it("a value the user edited after the analysis is left as it is (the book's other fields go on)", async () => {
    await setMode('analyse');
    // One edited book in a 3-book batch is 33 %: above the default 5 % it would pause the stage.
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ libraryChangedPausePercent: 50 })
      .expect(200);
    editInCalibre(env.lib, ids.B5, { title: 'ユーザーの題名' });
    await env.index();
    await setMode('on');
    await runAll(worker());
    const b5 = calibreRecord(env.lib, ids.B5)!;
    expect(b5.title).toBe('ユーザーの題名');
    expect(b5.authors).toEqual(['五郎']);
    const t = proposals('title').find((r) => r.calibre_id === ids.B5)!;
    expect(t.state).toBe('skipped');
    expect(t.review_reason).toContain('Changed in Calibre since the analysis');
  });

  it("waits stage 2's own pause between books (not stage 1's)", async () => {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { itemDelaySeconds: 0 }, stage2: { itemDelaySeconds: 0.4, chunkSize: 25 } })
      .expect(200);
    await setMode('on');
    await runAll(worker());
    const writes = fs
      .readFileSync(`${log}.times`, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .filter(([, cmd]) => cmd === 'set_metadata')
      .map(([t]) => Number(t));
    expect(writes.length).toBeGreaterThan(3);
    const gaps = writes.slice(1).map((t, i) => t - writes[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(380);
  });

  it('a write that times out but happens is recorded once; one that never happens fails after the wait, never sent twice', async () => {
    await setMode('on');
    await runAll(worker({ setTimeout: 'after' }));
    expect(calibreRecord(env.lib, ids.B1)!.title).toBe('本の題名 1');
    expect(proposals('title').filter((r) => r.state === 'applied').length).toBeGreaterThan(3);
    expect(setCalls().length).toBe(
      new Set(setCalls().map((c) => c[c.indexOf('--password') + 2])).size,
    );
  });

  it('a write Calibre never does: the book fails after the wait, the stage pauses, nothing is written twice', async () => {
    await setMode('on');
    const w = worker({ setTimeout: 'never', wait: 0.5 });
    await w.cycle(); // heartbeat and safety checks
    await env.service.tick();
    await w.cycle();
    const first = env.service.batches.list().find((b) => b.stage === 2)!;
    expect(first.state).toBe('failed');
    expect(env.service.batches.itemCounts(first.id).failed).toBeGreaterThan(0);
    expect(getStage(env.cleanupDb, 2).pauseReason).toBe('batch_failed');
    const books = new Set(setCalls().map((c) => c[c.indexOf('--password') + 2]));
    expect(setCalls().length).toBe(books.size);
  });

  it('a sidecar stopped after a write resumes without writing again', async () => {
    await setMode('on');
    let stoppedOnce = false;
    const breaking: typeof fetch = async (input, init) => {
      if (!stoppedOnce && String(input).includes('/written')) {
        stoppedOnce = true;
        w1.stop();
        throw new TypeError('fetch failed');
      }
      return fetch(input, init);
    };
    const w1 = worker({ fetchImpl: breaking });
    await w1.cycle(); // heartbeat and safety checks
    await env.service.tick();
    await w1.cycle().catch(() => {});
    const writesBefore = setCalls().length;
    expect(writesBefore).toBeGreaterThan(0);
    // The lease runs out; a new sidecar claims the batch and finds the write done.
    env.cleanupDb.prepare(`UPDATE batches SET lease_expires_at = 0 WHERE state = 'claimed'`).run();
    await runAll(worker());
    expect(calibreRecord(env.lib, ids.B1)!.title).toBe('本の題名 1');
    const perBook = new Map<string, number>();
    for (const c of setCalls()) {
      const id = c[c.indexOf('--password') + 2];
      perBook.set(id, (perBook.get(id) ?? 0) + 1);
    }
    expect([...perBook.values()].every((n) => n === 1)).toBe(true);
  });

  it('a field below its bar on the labeled books is paused alone; the page says why', async () => {
    // Labels that disagree with the files' titles.
    fs.writeFileSync(
      goldFile,
      JSON.stringify({
        [ids.B1]: { t: '別の題名', au: ['山田太郎'] },
        [ids.B2]: { t: '別の題名', au: ['佐藤花子'] },
      }),
    );
    await setMode('on');
    const pauses = listFieldPauses(env.cleanupDb, 2);
    expect(pauses.map((p) => [p.field, p.reason])).toEqual([['title', 'gate']]);
    expect(pauses[0].detail).toContain('below 85 %');
    await runAll(worker());
    expect(calibreRecord(env.lib, ids.B1)).toMatchObject({
      title: 'b1-scan',
      authors: ['山田太郎'],
    });
    // A gate pause can't be resumed by hand.
    await request(env.app)
      .post('/api/v1/cleanup/stages/2/fields/title/resume')
      .set(auth(user))
      .expect(409);
    const status = await request(env.app).get('/api/v1/cleanup/status').set(auth(user)).expect(200);
    expect(status.body.stage2.fieldPauses[0]).toMatchObject({ field: 'title', reason: 'gate' });
  });

  it('without the labeled books, titles and authors stay paused (other fields go on)', async () => {
    fs.rmSync(goldFile);
    await setMode('on');
    expect(listFieldPauses(env.cleanupDb, 2).map((p) => p.field)).toEqual(['authors', 'title']);
    await runAll(worker());
    expect(calibreRecord(env.lib, ids.B1)).toMatchObject({
      title: 'b1-scan',
      languages: ['jpn'],
      hasCover: true,
    });
  });

  it('pauses (and skips nothing) when many books changed in Calibre since the analysis', async () => {
    await setMode('analyse');
    for (const k of ['B1', 'B2', 'B5', 'B6', 'B8'])
      editInCalibre(env.lib, ids[k], { title: `edited ${k}` });
    await env.index();
    await setMode('on');
    await worker().cycle(); // heartbeat and safety checks
    await env.service.tick();
    expect(getStage(env.cleanupDb, 2).pauseReason).toBe('library_changed');
    expect(proposals().filter((r) => r.state === 'skipped')).toEqual([]);
    expect(env.service.batches.list()).toEqual([]);
  });

  it("keeps the sidecar's and the user's tokens apart on the stage-2 routes", async () => {
    await request(env.app)
      .post('/api/v1/cleanup-apply/batches/x/books/1/verify')
      .set(auth(user))
      .send({})
      .expect(401);
    await request(env.app)
      .get('/api/v1/cleanup-apply/batches/x/books/1/cover')
      .set(auth(user))
      .expect(401);
    await request(env.app).get('/api/v1/cleanup/status').set(auth(apply)).expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-apply/batches/x/books/1/verify')
      .set(auth(apply))
      .send({})
      .expect(404);
  });
});

describe('set_fields arguments', () => {
  const login = {
    contentServerUrl: 'http://c:8081',
    libraryId: 'lib',
    username: 'u',
    password: 'pw',
  };
  it('only the stage-2 fields, each once, remote, password on stdin', () => {
    const a = buildArgs('set_fields', login, [
      '5',
      'title:題名',
      'sort:題名',
      'authors:A & B',
      'author_sort:',
      'cover:/tmp/x.jpg',
    ]);
    expect(a.slice(0, 2)).toEqual(['set_metadata', '--with-library']);
    expect(a).toContain('<stdin>');
    expect(a).not.toContain('pw');
    expect(() => buildArgs('set_fields', login, ['5', 'tags:x'])).toThrow(/can't set tags/);
    expect(() => buildArgs('set_fields', login, ['5', 'comments:x'])).toThrow();
    expect(() => buildArgs('set_fields', login, ['5', 'title:a', 'title:b'])).toThrow(/twice/);
    expect(() => buildArgs('set_fields', login, ['5', 'title:'])).toThrow(/empty/);
    expect(() => buildArgs('set_fields', login, ['5', 'cover:relative.jpg'])).toThrow(/absolute/);
    expect(() => buildArgs('set_fields', login, ['x', 'title:a'])).toThrow();
    expect(() => buildArgs('set_fields', login, ['5', '-m'])).toThrow();
  });

  it('refuses a cover outside the temp and quarantine folders', async () => {
    const c = new Calibredb({ program: process.execPath, prefixArgs: [FAKE], timeoutMs: 5000 });
    await expect(c.setFields(login, 5, ['cover:/etc/passwd'], [makeTempDir('ok')])).rejects.toThrow(
      /not in the temp/,
    );
  });
});

void Database;
