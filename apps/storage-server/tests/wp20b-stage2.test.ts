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
import { CalibredbHelper } from '../../cleanup-apply/src/calibredb-helper';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { mayStillHappen, StepTimes, Worker, writeKind } from '../../cleanup-apply/src/worker';
import {
  PROPOSED_TWICE_REASON,
  SPLIT_WORD_REASON,
  TWO_VALUES_REASON,
} from '../src/cleanup/stage2-batches';
import { listFieldPauses } from '../src/cleanup/stage2-gate';
import { loadEvidence } from '../src/cleanup/stage2';
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
const FAKE_HELPER = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb-helper.cjs');
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
            // Two illustrators: a names column (like the NAS's) separates them with "&".
            { name: '画家 二', role: 'ill' },
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
        [ids.B8]: { t: '挿絵のある本', au: ['作家'], il: ['画家一', '画家二'] },
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
        pacing: {
          itemDelaySeconds: 0,
          batchSize: 500,
          maxBatchPercent: 10,
          readMbPerSecond: 0,
          lookupChunk: 2,
        },
        gate: { minBooks: 1, labeledBooksFile: goldFile },
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

  const helpers: CalibredbHelper[] = [];
  afterEach(() => {
    for (const h of helpers.splice(0)) h.stop();
  });

  /**
   * The sidecar with the stand-in calibredb. Like on the NAS, list and set_metadata go
   * through the long-lived helper (its stand-in) unless `helper` says otherwise.
   */
  function worker(
    extra: {
      setTimeout?: 'after' | 'never';
      wait?: number;
      fetchImpl?: typeof fetch;
      helper?: 'on' | 'off' | 'fail-start' | { dieAfterWrites: number };
      /** This Calibre id's writes are refused like the NAS's root-owned covers. */
      denied?: number;
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
        FAKE_SET_DENIED: extra.denied ? String(extra.denied) : '',
      },
      helper: helperFor(extra.helper ?? 'on', extra.setTimeout, extra.denied),
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

  function helperFor(
    mode: 'on' | 'off' | 'fail-start' | { dieAfterWrites: number },
    setTimeoutMode?: string,
    denied?: number,
  ): CalibredbHelper | null {
    if (mode === 'off') return null;
    const h = new CalibredbHelper({
      program: process.execPath,
      args: [FAKE_HELPER],
      startTimeoutMs: 10_000,
      env: {
        FAKE_CALIBRE_LIBRARY: env.lib.dir,
        FAKE_PASSWORD: PASSWORD,
        FAKE_VERSION: '9.18.0',
        FAKE_ILLUSTRATOR: '1',
        FAKE_LOG: log,
        FAKE_TIMES: `${log}.times`,
        FAKE_SET_TIMEOUT: setTimeoutMode ?? '',
        FAKE_SET_DENIED: denied ? String(denied) : '',
        FAKE_HELPER_LOG: `${log}.helper`,
        FAKE_HELPER_FAIL_START: mode === 'fail-start' ? '1' : '',
        FAKE_HELPER_DIE_AFTER_WRITES: typeof mode === 'object' ? String(mode.dieAfterWrites) : '',
      },
    });
    helpers.push(h);
    return h;
  }

  const helperCalls = () =>
    fs.existsSync(`${log}.helper`)
      ? fs.readFileSync(`${log}.helper`, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];

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
      if (r === 'idle' && !env.service.batches.open() && !env.service.batches.awaitingIngest(2)) {
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
    expect(proposals('illustrator')[0].new_json).toBe('["画家一","画家二"]');
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
    // Both names, as two values (sent "画家一 & 画家二": a comma would make one name).
    expect(calibreRecord(env.lib, ids.B8)!.illustrators).toEqual(['画家一', '画家二']);
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

  it('waits the pause between books from the batch it works on', async () => {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { itemDelaySeconds: 0.4, lookupChunk: 25 } })
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

  it("batches follow one another without the reader's index (no hold, no wait), and the index checks them afterwards", async () => {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { batchSize: 2 } })
      .expect(200);
    await setMode('on');
    const w = worker();
    await w.cycle(); // heartbeat and safety checks
    await env.service.tick();
    const first = env.service.batches.open()!;
    expect(first.stage).toBe(2);
    await w.cycle(); // claims it
    // A claimed stage-2 batch doesn't hold the reader's index (stage 1's does).
    expect(env.service.holdsIngest(env.libraryId())).toBe(false);
    for (let i = 0; i < 10 && env.service.batches.get(first.id)!.finishedAt === null; i++)
      await w.cycle();
    expect(env.service.batches.get(first.id)!.finishedAt).not.toBeNull();
    // Not indexed yet: the next batch is planned anyway.
    await env.service.tick();
    expect(env.service.batches.awaitingIngest(2)?.id).toBe(first.id);
    const second = env.service.batches.open();
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    // An index whose metadata.db copy predates the batch's end proves nothing: no pause.
    env.db
      .prepare(
        `UPDATE library_index_state SET snapshot_at = ?, indexed_at = ?, status = 'idle' WHERE library_id = ?`,
      )
      .run(first.finishedAt! - 1000, Date.now() + 1000, env.libraryId());
    env.service.batches.checkIngested();
    expect(getStage(env.cleanupDb, 2).pauseReason).toBeNull();
    // Once indexed, the first batch is marked taken in.
    await runAll(w);
    expect(env.service.batches.awaitingIngest(2)).toBeNull();
    expect(getStage(env.cleanupDb, 2).pauseReason).toBeNull();
    expect(env.service.batches.list().filter((b) => b.stage === 2).length).toBeGreaterThan(2);
  });

  it('a value Calibre stores differently after answering the write fails at once, without the long wait', async () => {
    await setMode('analyse');
    // A comma-separated column (no "Contains names") splits "X,Y" into two values.
    const cal = new Database(path.join(env.lib.dir, 'metadata.db'));
    cal.prepare(`UPDATE custom_columns SET display = '{}' WHERE label = 'illustrator'`).run();
    cal.close();
    await env.index();
    const row = env.cleanupDb
      .prepare(`SELECT id FROM proposed_changes WHERE stage = 2 AND field = 'illustrator' LIMIT 1`)
      .get() as { id: number };
    env.cleanupDb
      .prepare('UPDATE proposed_changes SET new_json = ? WHERE id = ?')
      .run(JSON.stringify(['X,Y']), row.id);
    await setMode('on');
    const t0 = Date.now();
    await runAll(worker({ wait: 60 }));
    expect(Date.now() - t0).toBeLessThan(30_000);
    const item = env.cleanupDb
      .prepare('SELECT state, detail FROM batch_items WHERE change_id = ?')
      .get(row.id) as { state: string; detail: string };
    expect(item.state).toBe('failed');
    expect(item.detail).toContain("doesn't show the new value");
  });

  it('a write Calibre refuses outright (Permission denied) fails at once; the others go on', async () => {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ failedPausePercent: 100 })
      .expect(200);
    await setMode('on');
    const t0 = Date.now();
    await runAll(worker({ denied: ids.B1, wait: 60 }));
    // Without the change this waits the full 60 s for a value that can't appear.
    expect(Date.now() - t0).toBeLessThan(30_000);
    const items = env.cleanupDb
      .prepare(
        `SELECT i.state, i.detail FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         WHERE c.calibre_id = ?`,
      )
      .all(ids.B1) as { state: string; detail: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.state === 'failed')).toBe(true);
    expect(items[0].detail).toContain('Permission denied');
    expect(calibreRecord(env.lib, ids.B2)!.title).toBe('正しい題名');
  });

  /** A second copy of a book's automatic proposals, as the NAS's analysis made on 2026-11-15. */
  function copyProposals(calibreId: number, field?: string, newJson?: string) {
    env.cleanupDb
      .prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
           source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
         SELECT stage, library_id, calibre_id, calibre_uuid, field, old_json, COALESCE(?, new_json),
           source, evidence_json, class, review_reason, state, analysis_id, created_at + 4600, updated_at
         FROM proposed_changes WHERE stage = 2 AND calibre_id = ? AND class = 'auto'
           AND state = 'proposed' ${field ? 'AND field = ?' : ''} ORDER BY id`,
      )
      .run(newJson ?? null, calibreId, ...(field ? [field] : []));
  }

  it('a change the analysis proposed twice is written once; the copy is set aside', async () => {
    await setMode('analyse');
    copyProposals(ids.B2);
    await setMode('on');
    await runAll(worker());
    const rows = proposals().filter((r) => r.calibre_id === ids.B2 && r.class === 'auto');
    const byField = new Map<string, typeof rows>();
    for (const r of rows) byField.set(r.field, [...(byField.get(r.field) ?? []), r]);
    expect(byField.size).toBeGreaterThan(1);
    for (const [, copies] of byField) {
      expect(copies.map((c) => c.state)).toEqual(['applied', 'skipped']);
      expect(copies[1].review_reason).toBe(PROPOSED_TWICE_REASON);
    }
    // Without the change the sidecar refuses the book ("title given twice") and nothing is written.
    const failed = env.cleanupDb
      .prepare(`SELECT COUNT(*) AS n FROM batch_items WHERE state = 'failed'`)
      .get() as { n: number };
    expect(failed.n).toBe(0);
    expect(calibreRecord(env.lib, ids.B2)).toMatchObject({
      title: '正しい題名',
      authors: ['佐藤花子'],
    });
    expect(setCalls().filter((a) => a.includes(String(ids.B2))).length).toBe(1);
  });

  it("two different values for one field: that field is set aside, the book's other fields are written", async () => {
    await setMode('analyse');
    copyProposals(ids.B2, 'title', JSON.stringify('別の題名'));
    await setMode('on');
    await runAll(worker());
    const titles = proposals('title').filter((r) => r.calibre_id === ids.B2 && r.class === 'auto');
    expect(titles.map((r) => [r.state, r.review_reason])).toEqual([
      ['skipped', TWO_VALUES_REASON],
      ['skipped', TWO_VALUES_REASON],
    ]);
    const b2 = calibreRecord(env.lib, ids.B2)!;
    expect(b2.title).toBe('Googleの題名');
    expect(b2.authors).toEqual(['佐藤花子']);
  });

  it('an analysis step run again before its cursor was saved proposes nothing twice', async () => {
    await setMode('analyse');
    const count = () =>
      (
        env.cleanupDb
          .prepare('SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 2')
          .get() as {
          n: number;
        }
      ).n;
    const before = count();
    // The propose phase again from just after the first book, with the same analysis.
    env.cleanupDb
      .prepare(
        `UPDATE stages SET progress_json = json_set(progress_json, '$.phase', 'propose', '$.proposeCursor', ?)
         WHERE stage = 2`,
      )
      .run(ids.B1);
    for (let i = 0; i < 20 && !(await env.service.analysis2!.step(() => false)); i++);
    expect(getStage(env.cleanupDb, 2).progress.phase).toBe('done');
    expect(count()).toBe(before);
  });

  it('error messages: a timeout or dropped connection may still happen; a refusal is final', () => {
    // Real messages (calibre 9.18 in the e2e; the NAS 2026-11-15).
    expect(
      mayStillHappen(
        'calibredb set_fields failed (exit 1): … httperror_seek_wrapper: HTTP Error 408: Request Timeout',
      ),
    ).toBe(true);
    expect(mayStillHappen('calibredb set_fields took longer than 600 s')).toBe(true);
    expect(mayStillHappen('The calibredb helper stopped (exit 3)')).toBe(true);
    expect(
      mayStillHappen(
        "calibredb set_fields failed (exit 1): [Errno 13] Permission denied: '/books/x/cover.jpg'",
      ),
    ).toBe(false);
    expect(
      mayStillHappen(
        "calibredb set_fields failed (exit 1): [Errno 36] File name too long: '/books/x'",
      ),
    ).toBe(false);
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

  it('a batch with failed items under the share set in the settings does not pause the stage', async () => {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ failedPausePercent: 100 })
      .expect(200);
    await setMode('on');
    const w = worker({ setTimeout: 'never', wait: 0.5 });
    await w.cycle(); // heartbeat and safety checks
    await env.service.tick();
    await w.cycle();
    const first = env.service.batches.list().find((b) => b.stage === 2 && b.state === 'failed')!;
    // Not paused: the next batch is already planned.
    expect(env.service.batches.list().some((b) => b.stage === 2 && b.state === 'planned')).toBe(
      true,
    );
    console.log(
      'DEBUG',
      first.state,
      JSON.stringify(env.service.batches.itemCounts(first.id)),
      getStage(env.cleanupDb, 2).pauseReason,
      env.service.batches
        .list()
        .map((b) => b.stage + b.state)
        .join(),
    );
    expect(env.service.batches.itemCounts(first.id).failed).toBeGreaterThan(0);
    expect(getStage(env.cleanupDb, 2).pauseReason).toBeNull();
    expect(env.logs.some((l) => l.includes('going on'))).toBe(true);
  });

  it('an author change whose name holds & goes to review when the batch is planned', async () => {
    await setMode('analyse');
    const row = env.cleanupDb
      .prepare(
        `SELECT id FROM proposed_changes WHERE stage = 2 AND field = 'authors' AND class = 'auto' LIMIT 1`,
      )
      .get() as { id: number };
    env.cleanupDb
      .prepare('UPDATE proposed_changes SET new_json = ? WHERE id = ?')
      .run(JSON.stringify(['蛇蔵&海野凪子']), row.id);
    await setMode('on');
    await worker().cycle();
    await env.service.tick();
    const after = env.cleanupDb
      .prepare('SELECT class, review_reason, state FROM proposed_changes WHERE id = ?')
      .get(row.id) as { class: string; review_reason: string; state: string };
    expect(after).toMatchObject({ class: 'review', state: 'proposed' });
    expect(after.review_reason).toContain('Calibre splits');
  });

  it('an author change Calibre would split at "and" goes to review when the batch is planned (29728)', async () => {
    await setMode('analyse');
    const row = env.cleanupDb
      .prepare(
        `SELECT id FROM proposed_changes WHERE stage = 2 AND field = 'authors' AND class = 'auto' LIMIT 1`,
      )
      .get() as { id: number };
    env.cleanupDb
      .prepare('UPDATE proposed_changes SET new_json = ? WHERE id = ?')
      .run(JSON.stringify(['Tôwa and Huuka Kazabana']), row.id);
    await setMode('on');
    await worker().cycle();
    await env.service.tick();
    const after = env.cleanupDb
      .prepare('SELECT class, review_reason, state FROM proposed_changes WHERE id = ?')
      .get(row.id) as { class: string; review_reason: string; state: string };
    expect(after).toMatchObject({ class: 'review', state: 'proposed' });
    expect(after.review_reason).toBe(SPLIT_WORD_REASON);
  });

  it("a value stage 4 wrote and Calibre still holds is Calibre's own: review, never automatic", async () => {
    // B2 is metadata-processed (the Google run): its title and author would be taken from the
    // file. Stage 4 wrote both since; Calibre still holds them.
    let uuid = '';
    env.lib.exec((db) => {
      uuid = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(ids.B2) as { uuid: string })
        .uuid;
    });
    const lib = env.libraryId();
    env.cleanupDb
      .prepare(
        `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at)
         VALUES ('stage4-batch', 4, ?, 'apply', 'applied', 2, 1, 1)`,
      )
      .run(lib);
    const put = env.cleanupDb.prepare(
      `INSERT INTO applied_values (library_id, calibre_uuid, field, value_json, source, batch_id, applied_at)
       VALUES (?, ?, ?, ?, 'amazon-asin', 'stage4-batch', 1)`,
    );
    put.run(lib, uuid, 'title', JSON.stringify('Googleの題名'));
    put.run(lib, uuid, 'authors', JSON.stringify(['Google Author']));
    await setMode('analyse');
    const rows = env.cleanupDb
      .prepare(
        `SELECT field, class FROM proposed_changes WHERE stage = 2 AND calibre_id = ? AND field IN ('title', 'authors')
         ORDER BY field`,
      )
      .all(ids.B2);
    expect(rows).toEqual([
      { field: 'authors', class: 'review' },
      { field: 'title', class: 'review' },
    ]);
  });

  it('a book whose folder moved since the snapshot is analysed where it is now, never recorded missing', async () => {
    // The analysis keeps the snapshot it started with; Calibre moves the folder meanwhile (seen
    // 2026-11-15: 4,277 books recorded "file_missing" while stage-2 batches moved them).
    const from = env.lib.bookDir(ids.B1);
    const to = path.join(env.lib.dir, 'Moved', `Book ${ids.B1} (${ids.B1})`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    env.lib.exec((db) =>
      db
        .prepare('UPDATE books SET path = ? WHERE id = ?')
        .run(`Moved/Book ${ids.B1} (${ids.B1})`, ids.B1),
    );
    await setMode('analyse');
    let uuid = '';
    env.lib.exec((db) => {
      uuid = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(ids.B1) as { uuid: string })
        .uuid;
    });
    const ev = loadEvidence(env.cleanupDb, env.libraryId(), uuid)!;
    expect(ev.error).toBeNull();
    expect(ev.path.startsWith('Moved/')).toBe(true);
    const fields = (
      env.cleanupDb
        .prepare(
          `SELECT field FROM proposed_changes WHERE stage = 2 AND calibre_id = ? AND class = 'auto'`,
        )
        .all(ids.B1) as { field: string }[]
    ).map((r) => r.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'authors', 'cover']));
  });

  it('a book whose folder moved after the analysis still gets its cover (read from where it is now)', async () => {
    await setMode('analyse');
    // Calibre moves the folder (any write does: seen 2026-11-15, 38253/38349/38350 lost their
    // covers to "The EPUB's cover can't be read any more").
    const from = env.lib.bookDir(ids.B1);
    const to = path.join(env.lib.dir, 'Moved', `Book ${ids.B1} (${ids.B1})`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    env.lib.exec((db) =>
      db
        .prepare('UPDATE books SET path = ? WHERE id = ?')
        .run(`Moved/Book ${ids.B1} (${ids.B1})`, ids.B1),
    );
    await env.index();
    await setMode('on');
    await runAll(worker());
    const b1 = calibreRecord(env.lib, ids.B1)!;
    expect(b1.hasCover).toBe(true);
    const cover = env.cleanupDb
      .prepare(
        `SELECT state, review_reason FROM proposed_changes WHERE stage = 2 AND calibre_id = ? AND field = 'cover'`,
      )
      .get(ids.B1) as { state: string; review_reason: string | null };
    expect(cover).toMatchObject({ state: 'applied' });
  });

  it("running the analysis again keeps a new-arrivals run's own proposals (arrivals:<run>)", async () => {
    await setMode('analyse');
    const lib = env.libraryId();
    const insert = env.cleanupDb.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (2, ?, ?, 'arrival-uuid', 'title', '"a"', '"b"', 'file', '{}', ?, ?, ?, 'arrivals:run-1', 1, 1)`,
    );
    const held = Number(
      insert.run(lib, 900001, 'auto', 'Held: the field is paused', 'skipped').lastInsertRowid,
    );
    const open = Number(
      insert.run(lib, 900002, 'review', 'A review item', 'proposed').lastInsertRowid,
    );
    env.service.reanalyse(2);
    for (let i = 0; i < 300 && getStage(env.cleanupDb, 2).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getStage(env.cleanupDb, 2).state).toBe('ready');
    const rows = env.cleanupDb
      .prepare(
        'SELECT id, state, review_reason FROM proposed_changes WHERE id IN (?, ?) ORDER BY id',
      )
      .all(held, open);
    expect(rows).toEqual([
      { id: held, state: 'skipped', review_reason: 'Held: the field is paused' },
      { id: open, state: 'proposed', review_reason: 'A review item' },
    ]);
    // The library's own undecided proposals were replaced by the new analysis.
    const analysisId = getStage(env.cleanupDb, 2).progress.analysisId as string;
    const stale = env.cleanupDb
      .prepare(
        `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND state = 'proposed'
           AND decided_by IS NULL AND analysis_id <> ? AND analysis_id NOT LIKE 'arrivals:%'`,
      )
      .get(analysisId) as { n: number };
    expect(stale.n).toBe(0);
  });

  it('a slow metadata.db copy answers "being made" in time and is never made twice for one batch', async () => {
    await setMode('on');
    await worker().cycle(); // heartbeat and safety checks
    await env.service.tick();
    const planned = env.service.batches.open()!;
    const svc = env.service.batches as unknown as {
      makeSnapshot: (b: unknown) => Promise<void>;
      snapshotAnswerMs: number;
    };
    const real = svc.makeSnapshot.bind(env.service.batches);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.makeSnapshot = async (b) => {
      calls += 1;
      await gate;
      return real(b);
    };
    svc.snapshotAnswerMs = 50;
    const first = await env.service.batches.claim();
    const second = await env.service.batches.claim();
    expect(first).toEqual({ batch: null, wait: 'metadata.db snapshot is being made' });
    expect(second).toEqual({ batch: null, wait: 'metadata.db snapshot is being made' });
    expect(calls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 200));
    // Once made, the next claim hands the batch out (the copy is reused, not made again).
    const sha = env.service.batches.get(planned.id)!.snapshotSha256;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const third = await env.service.batches.claim();
    expect(third.batch?.id).toBe(planned.id);
    expect(third.batch?.snapshotSha256).toBe(sha);
    const madeAt = fs.statSync(env.service.batches.snapshotFileFor(planned.id)).mtimeMs;
    expect(madeAt).toBeLessThan(Date.now());
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

  it('list and set_metadata go through the long-lived helper, the same calls as the program would make', async () => {
    await setMode('on');
    await runAll(worker());
    expect(calibreRecord(env.lib, ids.B1)!.title).toBe('本の題名 1');
    const viaHelper = helperCalls();
    expect(viaHelper.filter((c) => c.startsWith('set_metadata')).length).toBe(setCalls().length);
    expect(viaHelper.some((c) => c.startsWith('list'))).toBe(true);
  });

  it("a helper that can't start: the calls run with the calibredb program, nothing is lost", async () => {
    await setMode('on');
    await runAll(worker({ helper: 'fail-start' }));
    expect(calibreRecord(env.lib, ids.B1)!.title).toBe('本の題名 1');
    expect(helperCalls()).toEqual([]);
    expect(setCalls().length).toBeGreaterThan(3);
    expect(setCalls().length).toBe(
      new Set(setCalls().map((c) => c[c.indexOf('--password') + 2])).size,
    );
  });

  it('a helper that dies after a write: the write is found done, never sent again, and the rest go on', async () => {
    await setMode('on');
    await runAll(worker({ helper: { dieAfterWrites: 1 }, wait: 2 }));
    expect(calibreRecord(env.lib, ids.B1)!.title).toBe('本の題名 1');
    expect(proposals('title').filter((r) => r.state === 'failed')).toEqual([]);
    const perBook = new Map<string, number>();
    for (const c of setCalls()) {
      const id = c[c.indexOf('--password') + 2];
      perBook.set(id, (perBook.get(id) ?? 0) + 1);
    }
    expect(perBook.size).toBeGreaterThan(3);
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
  it('only the stage-2, stage-4 and stage-5 fields, each once, remote, password on stdin', () => {
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
    // Stage 5 (WP20f) adds exactly tags (the whole list the server worked out).
    expect(buildArgs('set_fields', login, ['5', 'tags:a,b'])).toContain('tags:a,b');
    // The user's edits from the reader (1.5.0) add exactly the published date and the rating.
    expect(
      buildArgs('set_fields', login, ['5', 'rating:4.5', 'pubdate:2020-01-01T12:00:00+00:00']),
    ).toContain('rating:4.5');
    expect(() => buildArgs('set_fields', login, ['5', 'timestamp:2020-01-01'])).toThrow(
      /can't set timestamp/,
    );
    // Stage 4 (WP20e) adds exactly series, series_index and comments.
    expect(() =>
      buildArgs('set_fields', login, ['5', 'series:S', 'series_index:1.5', 'comments:あらすじ']),
    ).not.toThrow();
    expect(() => buildArgs('set_fields', login, ['5', 'formats:x'])).toThrow();
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

describe('stage-2 step timing in the sidecar log', () => {
  it('names a write by what it holds and sums each step per chunk', async () => {
    expect(writeKind(['title:A', 'sort:A', 'cover:/tmp/x.jpg'])).toBe(
      'calibre write (cover + title/author)',
    );
    expect(writeKind(['authors:B', 'author_sort:'])).toBe('calibre write (title/author)');
    expect(writeKind(['identifiers:amazon_jp:B0X'])).toBe('calibre write (other fields)');
    const t = new StepTimes();
    await t.time('calibre write (title/author)', () => new Promise((r) => setTimeout(r, 30)));
    await t.time('calibre write (title/author)', () => new Promise((r) => setTimeout(r, 10)));
    t.add('server verify', 5);
    const s = t.summary(2);
    expect(s).toMatch(
      /^2 books in \d+\.\d s: calibre write \(title\/author\) \d+\.\d s \(2, max \d+\.\d s\) · server verify \d+\.\d s \(1, max \d+\.\d s\)$/,
    );
  });
});
