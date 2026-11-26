/**
 * WP20c: a stage-3 removal batch run by the real apply sidecar (apps/cleanup-apply) against a
 * real storage server, with the stand-in calibredb of the WP20a tests. Stage 3 uses stage 1's
 * item path unchanged: verify, export (the EPUB's SHA-256 must be the analysed file's), the
 * removed copy's own tags onto the copy that stays, remove (Calibre's trash), the handoff, and
 * Undo from the trash.
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
import { Worker } from '../../cleanup-apply/src/worker';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { getStage } from '../src/cleanup/stages';
import { calibreDate } from './helpers/calibre-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { chaptersOf, makeTextEpub, picture } from './helpers/stage3-fixture';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const FAKE_HELPER = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb-helper.cjs');
const PASSWORD = 'calibre-test-password';
const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const iso = (y: number) => calibreDate(new Date(Date.UTC(y, 0, 1)));
const quiet = { info: () => {}, error: () => {} };

describe('a stage-3 batch through the real sidecar', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let log: string;
  let user: string;
  let apply: string;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  let epubs: Record<string, Buffer>;
  const helpers: CalibredbHelper[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const listen = (s: http.Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );

  beforeEach(async () => {
    const made = await makeCleanupEnv({
      leaseSeconds: 60,
      service: { stage3Reader: new InProcessReader(bundle, IMPORT), counterBuild: 'test' },
    });
    env = made.env;
    const lo = [await picture(1, 500, 40)];
    const hi = [await picture(1, 1000, 92)];
    epubs = {
      A1: makeTextEpub({ title: 'A', chapters: chaptersOf(1), images: lo }),
      A2: makeTextEpub({ title: 'A', chapters: chaptersOf(1), images: hi }),
    };
    ids = {
      A1: await env.lib.addBook({
        title: 'A',
        authors: ['作者'],
        tags: ['PeepoHappyBooks'],
        timestamp: iso(2019),
        epub: epubs.A1,
      }),
      A2: await env.lib.addBook({
        title: 'A',
        authors: ['作者'],
        tags: ['ln'],
        timestamp: iso(2021),
        epub: epubs.A2,
      }),
    };
    // Other books so 10 % of the library allows the copy into one batch.
    for (let i = 0; i < 12; i++) {
      await env.lib.addBook({
        title: `Other ${i}`,
        authors: ['作者'],
        epub: makeTextEpub({ title: `Other ${i}`, chapters: chaptersOf(100 + i, 2, 3000) }),
      });
    }
    await made.setup();
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    uuids = {};
    for (const [k, id] of Object.entries(ids)) {
      uuids[k] = (
        mdb.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }
      ).uuid;
    }
    mdb.close();
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
    const ref = path.join(env.dbDir, 'cleanup', 'reference-sample');
    fs.mkdirSync(ref, { recursive: true });
    fs.writeFileSync(path.join(ref, 'gold800.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(ref, 'stage3-pairs.json'),
      JSON.stringify({
        pairs: [
          {
            key: 'a',
            group: 'test',
            a: ids.A1,
            b: ids.A2,
            measured: { aInB: 1, bInA: 1 },
            expected: 'duplicate',
          },
        ],
      }),
    );
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        pacing: { itemDelaySeconds: 0, batchSize: 500, maxBatchPercent: 10 },
        gate: {
          labeledBooksFile: path.join(ref, 'gold800.json'),
          duplicatePairsFile: path.join(ref, 'stage3-pairs.json'),
        },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
  }, 60_000);

  afterEach(async () => {
    for (const h of helpers.splice(0)) h.stop();
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker() {
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
    };
    const fakeEnv = {
      FAKE_CALIBRE_LIBRARY: env.lib.dir,
      FAKE_PASSWORD: PASSWORD,
      FAKE_VERSION: '9.18.0',
      FAKE_ILLUSTRATOR: '1',
      FAKE_LOG: log,
      FAKE_FAIL: '',
      FAKE_FAIL_LONG: '0',
      FAKE_TRASH_408: '',
      FAKE_REMOVE_TIMEOUT: '',
      FAKE_ADD_TIMEOUT: '',
      FAKE_LIST_408_FILE: '',
    };
    const helper = new CalibredbHelper({
      program: process.execPath,
      args: [FAKE_HELPER],
      startTimeoutMs: 10_000,
      env: { ...fakeEnv, FAKE_HELPER_LOG: `${log}.helper` },
    });
    helpers.push(helper);
    return new Worker({
      config,
      calibredb: new Calibredb({
        program: process.execPath,
        prefixArgs: [FAKE],
        timeoutMs: 60_000,
        env: fakeEnv,
        helper,
      }),
      log: quiet,
      retryMinMs: 20,
      retryMaxMs: 100,
    });
  }

  function tagsOf(id: number): string[] {
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const rows = mdb
      .prepare(
        'SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ? ORDER BY t.name',
      )
      .all(id) as { name: string }[];
    mdb.close();
    return rows.map((r) => r.name);
  }

  async function runAll(w: Worker, rounds = 10) {
    for (let i = 0; i < rounds; i++) {
      await env.service.tick();
      const r = await w.cycle();
      await env.index();
      await env.service.tick();
      if (r === 'idle' && !env.service.batches.open()) return;
    }
  }

  it('removes the worse copy into the quarantine and the trash, copies your tags, hands off, undoes', async () => {
    const a1Reader = env.readerBook(uuids.A1)!.bookId;
    env.addReaderData(a1Reader);
    const w = worker();
    await w.runChecks();
    await w.cycle();
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(200);
    for (let i = 0; i < 400 && getStage(env.cleanupDb, env.libraryId(), 3).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    const p = env.service.analysis3!.progress()!;
    expect(p.gate?.passed).toBe(true);
    expect(p.toRemove).toBe(1);
    await runAll(w);

    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const left = (mdb.prepare('SELECT id FROM books').all() as { id: number }[]).map((r) => r.id);
    mdb.close();
    expect(left).not.toContain(ids.A1);
    expect(left).toContain(ids.A2);
    expect(fs.readdirSync(path.join(env.lib.dir, '.caltrash', 'b'))).toEqual([String(ids.A1)]);
    // A1's own tag is now on the copy that stays.
    expect(tagsOf(ids.A2)).toEqual(['ln', 'PeepoHappyBooks']);
    // The export is the analysed file, byte for byte.
    const [batchId] = fs.readdirSync(quarantine);
    expect(sha(fs.readFileSync(path.join(quarantine, batchId, String(ids.A1), 'book.epub')))).toBe(
      sha(epubs.A1),
    );
    // The handoff: A1's reader book (with data) now shows A2's record.
    expect(env.readerBook(uuids.A2)).toEqual({ bookId: a1Reader, missing: false });
    const batch = env.service.batches.list()[0];
    expect([batch.stage, batch.state]).toEqual([3, 'applied']);
    expect(batch.ingestedAt).not.toBeNull();

    // Undo from Calibre's trash: same id and UUID, the tag taken off, the swap reversed.
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    expect(env.readerBook(uuids.A1)).toEqual({ bookId: a1Reader, missing: false });
    expect(tagsOf(ids.A2)).toEqual(['ln']);
    expect(env.service.batches.get(batch.id)!.state).toBe('undone');
  }, 120_000);
});
