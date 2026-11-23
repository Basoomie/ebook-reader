/**
 * WP20e: stage 4 On through stage 2's field-write path, with the real apply sidecar and the
 * stand-in calibredb: the fields stage 4 writes (title, authors with their reading in one
 * write, #illustrator, series and number, the description, store links, the store's cover),
 * the ones it never writes (format, edition kind, review items), what is recorded for the
 * check "changed in Calibre after the cleanup wrote it", Undo, and a sidecar too old for
 * stage 4 never getting its batch.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { updateStage } from '../src/cleanup/stages';
import { stillAsWritten } from '../src/cleanup/stage4/proposals';
import { calibreNameBytes, NAME_MAX_BYTES } from '../src/cleanup/calibre-names';
import { makeJpeg } from './helpers/calibre-fixture';
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

describe('stage 4 On: written through the field-write path', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let log: string;
  let ids: Record<string, number>;
  let storeCover: Buffer;
  let url: string;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    storeCover = await makeJpeg(40);
    ids = {
      S1: await env.lib.addBook({
        title: '古い題名',
        authors: ['古い作者'],
        cover: 'none',
        comments: '古いあらすじ',
        epub: makeMetaEpub({ title: '新しい題名 2', creators: [{ name: '作者', role: 'aut' }] }),
      }),
      S3: await env.lib.addBook({
        title: '短い題名',
        authors: ['作者三'],
        cover: 'none',
        epub: makeMetaEpub({ title: '短い題名', creators: [{ name: '作者三', role: 'aut' }] }),
      }),
      S2: await env.lib.addBook({
        title: '別の本',
        authors: ['別の作者'],
        cover: 'none',
        epub: makeMetaEpub({ title: '別の本', creators: [{ name: '別の作者', role: 'aut' }] }),
      }),
    };
    for (let i = 0; i < 20; i++)
      await env.lib.addBook({
        title: `棚の本 ${i}`,
        authors: ['棚の作者'],
        cover: 'none',
        epub: makeMetaEpub({ title: `棚の本 ${i}`, creators: [{ name: '棚の作者', role: 'aut' }] }),
      });
    await made.setup();
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    log = path.join(makeTempDir('log'), 'calls.log');
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
    // The store's picture comes from the fetch cache.
    env.service.batches.stage4.setStoreCover((u) =>
      u === 'https://m.media-amazon.com/x.jpg' ? storeCover : null,
    );
    // A finished stage-4 analysis with its proposals (the AI check decided them).
    updateStage(env.cleanupDb, 4, {
      progress: { analysisId: 'a4', phase: 'done', libraryId: env.libraryId() } as Record<
        string,
        unknown
      >,
    });
    const uuid = (id: number) =>
      (
        new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true })
          .prepare('SELECT uuid FROM books WHERE id = ?')
          .get(id) as { uuid: string }
      ).uuid;
    const put = env.cleanupDb.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'a4', 1, 1)`,
    );
    const p = (
      id: number,
      field: string,
      oldV: unknown,
      newV: unknown,
      cls = 'auto',
      ev: Record<string, unknown> = {},
    ) =>
      put.run(
        env.libraryId(),
        id,
        uuid(id),
        field,
        JSON.stringify(oldV),
        JSON.stringify(newV),
        'amazon-asin',
        JSON.stringify(ev),
        cls,
        cls === 'review' ? 'unsure' : null,
      );
    p(ids.S1, 'title', '古い題名', '新しい題名 2');
    p(ids.S1, 'authors', ['古い作者'], ['作者']);
    p(ids.S1, 'author_sort', calibreRecord(env.lib, ids.S1)!.authorSort, 'サクシャ');
    p(ids.S1, 'illustrator', [], ['絵師'], 'auto', { unconfirmed: true });
    p(ids.S1, 'series', { name: null, index: null }, { name: 'シリーズ', index: 2.5 });
    p(ids.S1, 'description', '古いあらすじ', '新しいあらすじ。\n二行目。');
    p(ids.S1, 'identifiers', {}, { amazon_jp: 'B0X', bookmeter: '9' });
    p(ids.S1, 'cover', false, { url: 'https://m.media-amazon.com/x.jpg', side: 1500 }, 'auto', {
      hadCover: false,
    });
    p(ids.S1, 'format', null, 'light novel');
    p(ids.S1, 'kind', null, 'full');
    p(ids.S2, 'title', '別の本', '直さない題名', 'review');
    // A title whose folder name would not fit in 255 bytes: the book's other fields wait too.
    p(ids.S3, 'title', '短い題名', '長'.repeat(100));
    p(ids.S3, 'description', null, 'あらすじ');
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
      },
      helper: null,
    });
    return new Worker({ config, calibredb, log: quiet, retryMinMs: 20, retryMaxMs: 100 });
  }

  async function runBatch(w: Worker) {
    for (let i = 0; i < 20; i++) {
      const r = await w.cycle();
      if (r === 'idle' && !env.service.batches.open()) return;
    }
  }

  const libRow = (sql: string, id: number) => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return db.prepare(sql).get(id) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  };
  const series = (id: number) =>
    libRow(
      'SELECT s.name, b.series_index AS idx FROM books b LEFT JOIN books_series_link l ON l.book = b.id LEFT JOIN series s ON s.id = l.series WHERE b.id = ?',
      id,
    );
  const comments = (id: number) =>
    libRow('SELECT text FROM comments WHERE book = ?', id)?.text ?? null;
  const setCalls = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[])
      .filter((a) => a[0] === 'set_metadata');

  it('writes the fields in one call per book, never format, kind or review items; Undo puts them back', async () => {
    const before = (
      env.service.stage4Status(env.libraryId(), Date.now()) as {
        write: { changes: { done: number; total: number } } | null;
      }
    ).write;
    const plan = await env.service.batches.stage4.plan(env.libraryId());
    expect(plan.batch).not.toBeNull();
    // A planned batch's changes (queued) still count as to write: the total stays.
    const planned = (
      env.service.stage4Status(env.libraryId(), Date.now() + 60_000) as {
        write: { changes: { done: number; total: number } } | null;
      }
    ).write;
    if (before) expect(planned?.changes.total).toBe(before.changes.total);
    expect(planned?.changes).toMatchObject({ done: 0 });
    expect(planned!.changes.total).toBeGreaterThan(0);
    const w = worker();
    await runBatch(w);
    const r = calibreRecord(env.lib, ids.S1)!;
    expect(r).toMatchObject({
      title: '新しい題名 2',
      authors: ['作者'],
      // The reading went with the authors in the same write.
      authorSort: 'サクシャ',
      illustrators: ['絵師'],
      identifiers: { amazon_jp: 'B0X', bookmeter: '9' },
      hasCover: true,
    });
    expect(series(ids.S1)).toMatchObject({ name: 'シリーズ', idx: 2.5 });
    expect(comments(ids.S1)).toBe('新しいあらすじ。\n二行目。');
    const folder = path.join(env.lib.dir, ...r.path.split('/'));
    expect(fs.readFileSync(path.join(folder, 'cover.jpg')).equals(storeCover)).toBe(true);
    // Review items and the fields stage 5 carries stay out.
    expect(calibreRecord(env.lib, ids.S2)!.title).toBe('別の本');
    // A title too long for Calibre's names is cut to fit (2026-11-22), written with the other
    // fields, and listed as shortened.
    const s3 = calibreRecord(env.lib, ids.S3)!;
    expect(s3.title.endsWith('…')).toBe(true);
    expect(calibreNameBytes(ids.S3, s3.title, s3.authors[0] ?? 'Unknown')).toBeLessThanOrEqual(
      NAME_MAX_BYTES,
    );
    expect(comments(ids.S3)).toBe('あらすじ');
    expect(
      env.cleanupDb
        .prepare('SELECT original, written, step FROM calibre_title_fits WHERE calibre_id = ?')
        .all(ids.S3),
    ).toEqual([{ original: '長'.repeat(100), written: s3.title, step: 'cut' }]);
    const calls = setCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].some((a) => /^(format|kind|tags):/.test(a))).toBe(false);
    expect(calls[0].filter((a) => a.startsWith('author_sort:'))).toEqual(['author_sort:サクシャ']);
    const states = env.cleanupDb
      .prepare(
        `SELECT field, state FROM proposed_changes WHERE stage = 4 AND calibre_id = ? ORDER BY field`,
      )
      .all(ids.S1) as { field: string; state: string }[];
    expect(
      Object.fromEntries(states.filter((s) => s.field !== 'title').map((s) => [s.field, s.state])),
    ).toMatchObject({
      authors: 'applied',
      author_sort: 'applied',
      cover: 'applied',
      description: 'applied',
      format: 'proposed',
      kind: 'proposed',
    });
    // The card's progress: changes written, books written, all of them (stage-4 status).
    const st = env.service.stage4Status(env.libraryId(), Date.now() + 120_000) as {
      write: {
        changes: { done: number; total: number };
        books: { done: number };
        batches: number;
      } | null;
    };
    expect(st.write).toMatchObject({ books: { done: 2 }, batches: 1 });
    expect(st.write!.changes.done).toBeGreaterThan(0);
    expect(st.write!.changes.done).toBe(st.write!.changes.total);
    // Recorded so that a later check tells Calibre's own value from a user's change.
    const applied = new Map(
      (
        env.cleanupDb.prepare('SELECT field, value_json FROM applied_values').all() as {
          field: string;
          value_json: string;
        }[]
      ).map((a) => [a.field, JSON.parse(a.value_json)]),
    );
    expect(applied.get('cover')).toMatchObject({ mediaType: 'image/jpeg' });
    expect(
      stillAsWritten('cover', applied.get('cover'), true, {
        hasCover: true,
        now: { sha256: applied.get('cover').sha256, dhash: null },
        fileDhash: null,
        sameDistance: 5,
      }),
    ).toBe(true);
    expect(stillAsWritten('series', applied.get('series'), { name: 'シリーズ', index: 2.5 })).toBe(
      true,
    );

    // Undo.
    const batchId = (
      env.cleanupDb.prepare(`SELECT id FROM batches WHERE stage = 4 AND kind = 'apply'`).get() as {
        id: string;
      }
    ).id;
    const sortBefore = (
      env.cleanupDb
        .prepare(`SELECT old_json FROM proposed_changes WHERE stage = 4 AND field = 'author_sort'`)
        .get() as { old_json: string }
    ).old_json;
    const undo = env.service.batches.undo(batchId);
    await runBatch(w);
    expect(env.service.batches.get(batchId)!.state).toBe('undone');
    expect(calibreRecord(env.lib, ids.S1)!.authorSort).toBe(JSON.parse(sortBefore));
    // The content server can't remove a cover: the store's stays, said so on the item.
    const coverItem = env.cleanupDb
      .prepare(
        `SELECT i.state, i.detail FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
                WHERE i.batch_id = ? AND c.field = 'cover'`,
      )
      .get(undo.id) as { state: string; detail: string };
    expect(coverItem).toMatchObject({ state: 'restored' });
    expect(coverItem.detail).toMatch(/store's cover stays/);
    expect(calibreRecord(env.lib, ids.S1)).toMatchObject({
      title: '古い題名',
      authors: ['古い作者'],
      illustrators: [],
      identifiers: {},
    });
    expect(series(ids.S1)?.name ?? null).toBeNull();
    expect(comments(ids.S1)).toBe('古いあらすじ');
  });

  it('a sidecar older than 1.1.0 never gets a stage-4 batch', async () => {
    await env.service.batches.stage4.plan(env.libraryId());
    env.cleanupDb.prepare(`UPDATE sidecar_status SET version = '1.0.0' WHERE id = 1`).run();
    const c = await env.service.batches.claim();
    expect(c.batch).toBeNull();
    expect(c.wait).toMatch(/older than 1\.1\.0/);
  });
});
