/**
 * Tier 4, part 2: Calibre records without files (no formats, no folder) are deleted once their
 * EPUB is in Calibre as a new book, through the real sidecar (apps/cleanup-apply) and the
 * stand-in calibredb (modelled on calibre 9.18: a record without a folder leaves nothing in the
 * trash). No Undo; the record is saved whole in the quarantine first; its own tags go to the new
 * book.
 */
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
import { EMPTY_RECORD_STAGE } from '../src/cleanup/field-stages';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const FAKE_HELPER = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb-helper.cjs');
const PASSWORD = 'calibre-test-password';
const quiet = { info: () => {}, error: () => {} };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const LONG =
  '異世界ゆるっとサバイバル生活 番外編～学校の皆と異世界の無人島に転移したけど俺だけ楽勝です～１';

describe('records without files (tier 4, part 2)', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let user: string;
  let apply: string;
  let ids: Record<string, number>;
  const helpers: CalibredbHelper[] = [];

  /**
   * A record Calibre's import made without its folder (no data rows, no folder): its folder
   * name was over 255 bytes, as on the NAS (`long: false`: a record that lost its files some
   * other way, which is not one of these).
   */
  async function emptyRecord(
    title: string,
    authors: string[],
    tags: string[],
    long = true,
  ): Promise<number> {
    const id = await env.lib.addBook({ title, authors, tags, cover: 'none', formats: [] });
    fs.rmSync(env.lib.bookDir(id), { recursive: true, force: true });
    if (long)
      env.lib.exec((db) =>
        db
          .prepare('UPDATE books SET path = ? WHERE id = ?')
          .run(`${authors[0]}/${'長'.repeat(90)} (${id})`, id),
      );
    return id;
  }

  function arrival(
    relPath: string,
    facts: object,
    calibreId: number | null,
    uuid: string | null,
    outcome = 'added',
  ) {
    env.cleanupDb
      .prepare(
        `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind,
           outcome, calibre_id, calibre_uuid, facts_json)
         VALUES ('p|src', ?, 10, 1, 1, 1, 'epub', ?, ?, ?, ?)`,
      )
      .run(relPath, outcome, calibreId, uuid, JSON.stringify(facts));
  }

  const uuidOf = (id: number) => {
    let u = '';
    env.lib.exec((db) => {
      u = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }).uuid;
    });
    return u;
  };
  const inCalibre = (id: number) => {
    let n = 0;
    env.lib.exec((db) => {
      n = (db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(id) as { n: number }).n;
    });
    return n === 1;
  };
  const tagsOf = (id: number) => {
    let t: string[] = [];
    env.lib.exec((db) => {
      t = (
        db
          .prepare(
            'SELECT t.name FROM tags t JOIN books_tags_link l ON l.tag = t.id WHERE l.book = ? ORDER BY t.name',
          )
          .all(id) as { name: string }[]
      ).map((r) => r.name);
    });
    return t;
  };

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    ids = {
      // Its EPUB was added as a new book (fitted title), with the record's title in the file.
      E1: await emptyRecord(LONG, ['絢乃'], ['needs-metadata', 'PeepoHappyBooks']),
      N1: await env.lib.addBook({
        title: '異世界ゆるっとサバイバル生活 番外編… １',
        authors: ['絢乃'],
        cover: 'none',
      }),
      // Its EPUB isn't in Calibre yet.
      E2: await emptyRecord('まだ来ない本', ['作者'], ['needs-metadata']),
      // The same book's record twice (65653/65654 on the NAS): one EPUB, both go.
      E3: await emptyRecord('同じ本 14', ['明鏡シスイ'], ['TMW-collection-13']),
      E4: await emptyRecord('同じ本 14', ['明鏡シスイ'], ['TMW-collection-13']),
      N3: await env.lib.addBook({ title: '同じ本 14', authors: ['明鏡シスイ'], cover: 'none' }),
      // No files but a folder: not one of these.
      F1: await env.lib.addBook({
        title: 'Folder only',
        authors: ['X'],
        cover: 'none',
        formats: [],
      }),
      // No files and no folder, but a name the disk takes: lost some other way, not one of these.
      F2: await emptyRecord('Lost otherwise', ['Y'], [], false),
    };
    await made.setup();
    arrival('a/long.epub', { title: LONG, authors: ['絢乃'] }, ids.N1, uuidOf(ids.N1));
    arrival('a/same.epub', { title: '同じ本 14', authors: ['明鏡シスイ'] }, ids.N3, uuidOf(ids.N3));
    // An arrival with the right title that was never added: E2 waits.
    arrival('a/later.epub', { title: 'まだ来ない本', authors: ['作者'] }, null, null, 'new');
    await env.index();
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    (env as unknown as { url: string }).url = `http://127.0.0.1:${await listen(server)}`;
    const cport = await listen(calibreServer);
    quarantine = makeTempDir('quarantine');
    user = env.userToken();
    apply = env.applyToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ contentServerUrl: `http://127.0.0.1:${cport}`, calibreUsername: 'u' })
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

  function worker() {
    const fakeEnv = {
      FAKE_CALIBRE_LIBRARY: env.lib.dir,
      FAKE_PASSWORD: PASSWORD,
      FAKE_VERSION: '9.18.0',
    };
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
      writeWaitSeconds: 2,
      coverTmpDir: makeTempDir('covers'),
    };
    const helper = new CalibredbHelper({
      program: process.execPath,
      args: [FAKE_HELPER],
      startTimeoutMs: 10_000,
      env: fakeEnv,
    });
    helpers.push(helper);
    const calibredb = new Calibredb({
      program: process.execPath,
      prefixArgs: [FAKE],
      timeoutMs: 60_000,
      env: fakeEnv,
      helper,
    });
    return new Worker({ config, calibredb, log: quiet, retryMinMs: 20, retryMaxMs: 100 });
  }

  const list = async () =>
    (await request(env.app).get('/api/v1/cleanup/empty-records').set(auth(user)).expect(200)).body
      .records as {
      calibreId: number;
      state: string;
      reason: string | null;
      newBook: { calibreId: number } | null;
      addTags: string[];
    }[];

  it('lists each record without files with its state and the new book holding its EPUB', async () => {
    const rows = await list();
    expect(rows.map((r) => [r.calibreId, r.state, r.newBook?.calibreId ?? null])).toEqual([
      [ids.E1, 'ready', ids.N1],
      [ids.E2, 'waiting', null],
      [ids.E3, 'ready', ids.N3],
      [ids.E4, 'ready', ids.N3],
    ]);
    // Only the user's own tags go to the new book (workflow tags stay behind).
    expect(rows[0].addTags).toEqual(['PeepoHappyBooks']);
    expect(rows[1].reason).toContain('not in Calibre');
  });

  it('deletes the ready ones through the sidecar, saving each record first; the waiting one stays', async () => {
    const w = worker();
    await w.cycle(); // the heartbeat names the sidecar's version (1.6.0)
    const res = await request(env.app)
      .post('/api/v1/cleanup/empty-records/delete')
      .set(auth(user))
      .send({})
      .expect(200);
    const batchId = res.body.batch.id as string;
    for (let i = 0; i < 10 && env.service.batches.get(batchId)!.state !== 'applied'; i++) {
      await w.cycle();
      await env.service.tick();
    }
    expect(env.service.batches.get(batchId)!.state).toBe('applied');
    expect([ids.E1, ids.E3, ids.E4].map(inCalibre)).toEqual([false, false, false]);
    expect(inCalibre(ids.E2)).toBe(true);
    expect(tagsOf(ids.N1)).toEqual(['PeepoHappyBooks']);
    expect(tagsOf(ids.N3)).toEqual(['TMW-collection-13']);
    // The whole record as Calibre listed it, in the batch's quarantine folder.
    const saved = JSON.parse(
      fs.readFileSync(path.join(quarantine, batchId, `${ids.E1}.json`), 'utf8'),
    ) as { record: { title: string; tags: string[] }; newBook: { calibreId: number } };
    expect(saved.record.title).toBe(LONG);
    expect(saved.newBook.calibreId).toBe(ids.N1);
    await env.index();
    const after = await list();
    expect(after.map((r) => [r.calibreId, r.state])).toEqual([
      [ids.E1, 'deleted'],
      [ids.E2, 'waiting'],
      [ids.E3, 'deleted'],
      [ids.E4, 'deleted'],
    ]);
    // No Undo: calibre keeps nothing of a record without a folder.
    const undo = await request(env.app)
      .post(`/api/v1/cleanup/batches/${batchId}/undo`)
      .set(auth(user))
      .expect(409);
    expect(undo.body.error?.message ?? JSON.stringify(undo.body)).toContain(
      "can't be brought back",
    );
  });

  it('never hands the batch to an older sidecar, and plans nothing without one', async () => {
    const res = await request(env.app)
      .post('/api/v1/cleanup/empty-records/delete')
      .set(auth(user))
      .send({})
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('older than 1.6.0');
    expect(
      env.cleanupDb
        .prepare(`SELECT COUNT(*) AS n FROM batches WHERE stage = ${EMPTY_RECORD_STAGE}`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it('skips a record that got a folder or files since it was listed; it is left alone', async () => {
    const w = worker();
    await w.cycle();
    const res = await request(env.app)
      .post('/api/v1/cleanup/empty-records/delete')
      .set(auth(user))
      .send({ ids: [ids.E1, ids.E3] })
      .expect(200);
    const batchId = res.body.batch.id as string;
    // E1 gets its folder back, E3 a file, before the sidecar takes the batch.
    env.lib.exec((db) => {
      const p = (db.prepare('SELECT path FROM books WHERE id = ?').get(ids.E1) as { path: string })
        .path;
      // A folder named like the record's (the test disk takes the long name; the NAS's wouldn't).
      fs.mkdirSync(path.join(env.lib.dir, ...p.split('/')), { recursive: true });
    });
    env.lib.exec((db) =>
      db
        .prepare(
          "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, 'EPUB', 1, 'x')",
        )
        .run(ids.E3),
    );
    for (
      let i = 0;
      i < 10 && !['applied', 'partial', 'failed'].includes(env.service.batches.get(batchId)!.state);
      i++
    ) {
      await w.cycle();
      await env.service.tick();
    }
    expect(inCalibre(ids.E1)).toBe(true);
    expect(inCalibre(ids.E3)).toBe(true);
    expect(inCalibre(ids.E4)).toBe(true);
    const items = env.service.batches.items(batchId) as {
      calibre_id: number;
      state: string;
      detail: string;
    }[];
    expect(items.map((i) => [i.calibre_id, i.state])).toEqual([
      [ids.E1, 'skipped'],
      [ids.E3, 'skipped'],
    ]);
    expect(items[0].detail).toContain('folder');
    expect(items[1].detail).toContain('files in Calibre now');
  });
});
