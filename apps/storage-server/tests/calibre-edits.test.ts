/**
 * Calibre metadata editing from the reader (tier 3 item 2): the user's edits through the
 * cleanup's field-write path with the real apply sidecar and the stand-in calibredb; refusals
 * (names too long for Calibre's folders, "&"); edits ahead of queued cleanup batches and between
 * a running batch's chunks; fields that are the user's (never proposed or written again);
 * "Changed in Calibre"; the history and its Undo; the series editor; "Tags you can pick".
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { importCovers } from '../../cleanup-apply/src/import-covers';
import { diffBook, metaHash, type CalibreBook } from '../src/calibre/ingest';
import { caseOnlyRenames } from '../src/cleanup/edits/attribution';
import { checkNames, normalizeValue, userKeysOf } from '../src/cleanup/edits/fields';
import { seriesPairsOf } from '../src/cleanup/edits/series';
import { EDIT_STAGE } from '../src/cleanup/field-stages';
import {
  STAGE5_SCHEMA,
  STAGE5_SPEC,
  STAGE5_SYSTEM,
  stage5SpecFor,
} from '../src/cleanup/stage5/prompt';
import { changeTagList, DEFAULT_TAG_LIST, effectiveVocab } from '../src/cleanup/stage5/tag-list';
import { tagChange } from '../src/cleanup/stage5/decide';
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
const sha1 = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/** A cover with a dark band ending at column `k` of 8 (flat pictures share one difference hash). */
async function patterned(k: number): Promise<Buffer> {
  const band = await sharp({
    create: { width: 75 * k, height: 900, channels: 3, background: '#000' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 600, height: 900, channels: 3, background: '#fff' } })
    .composite([{ input: band, left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
}

describe('pure parts', () => {
  it('keeps the library’s stage-5 question exactly as on main (hash from origin/main)', () => {
    expect(sha1(STAGE5_SYSTEM)).toBe('f24087cb3a13d257fb18068e9ff61cb9588887ea');
    expect(sha1(STAGE5_SCHEMA)).toBe('13123e60e245b48c2f05ab4affeffe63a5a582ab');
    expect(stage5SpecFor(effectiveVocab(DEFAULT_TAG_LIST))).toBe(STAGE5_SPEC);
  });

  it('a changed tag list is its own question for new books, with the added tag and without a removed one', () => {
    let list = changeTagList(DEFAULT_TAG_LIST, ['PeepoHappyBooks'], { group: 'tag', add: '麻雀' });
    list = changeTagList(list.tagList, list.customTags, { group: 'genre', remove: '官能' });
    const v = effectiveVocab(list.tagList);
    const spec = stage5SpecFor(v);
    expect(spec.promptVersion).not.toBe(STAGE5_SPEC.promptVersion);
    expect(spec.system).toContain('麻雀: 麻雀');
    expect(spec.system).not.toContain('官能');
    expect(spec.parseAnswer({ genres: ['adult', 'fantasy'], tags: ['麻雀'] })).toMatchObject({
      genres: ['fantasy'],
      tags: ['麻雀'],
    });
    // The new books' tag change: the added tag written with its label, a removed one never.
    const ch = tagChange(['麻雀', 'fantasy', 'adult'], 'novel', [], ['PeepoHappyBooks'], [], {
      label: (id) => v.byId.get(id)?.ja ?? null,
      format: (f) => v.formats[f]?.ja ?? null,
    });
    expect(ch.add.sort()).toEqual(['ファンタジー', '小説', '麻雀'].sort());
    // Your tags are the cleanup's customTags; a duplicate is refused.
    const y = changeTagList(list.tagList, list.customTags, {
      group: 'yours',
      add: 'needs-metadata',
    });
    expect(y.customTags).toContain('needs-metadata');
    expect(() =>
      changeTagList(y.tagList, y.customTags, { group: 'tag', add: 'needs-metadata' }),
    ).toThrow(/already/);
  });

  it('the rating and languages stay out of the record’s change hash (no full catalog rewrite)', () => {
    const book = {
      calibreId: 1,
      uuid: 'u',
      title: 't',
      titleSort: 't',
      authorSort: 'a',
      authors: [{ name: 'a', sort: 'a' }],
      series: null,
      seriesIndex: null,
      tags: [],
      illustrators: [],
      identifiers: {},
      description: null,
      publisher: null,
      publishedAt: null,
      addedAt: 0,
      lastModified: 1,
      path: 'p',
      filePath: 'p/f.epub',
      fileSize: 1,
      hasCover: false,
    } as CalibreBook;
    const before = createHash('sha1').update(JSON.stringify(book)).digest('hex');
    expect(metaHash({ ...book, rating: 8, languages: ['jpn'] })).toBe(before);
    const d = diffBook(
      {
        title: 't',
        titleSort: 't',
        authorSort: 'a',
        authors: ['a'],
        illustrators: [],
        series: 'S',
        seriesIndex: 1,
        publisher: null,
        publishedAt: null,
        description: null,
        tags: ['B', 'a'],
        identifiers: { x: '1' },
        rating: undefined,
        coverSig: '1:1',
      },
      { ...book, tags: ['a', 'B'], series: { name: 'S', sort: 'S' }, seriesIndex: 2, rating: 4 },
      '2:2',
    );
    // Tags compare as a set; the rating not stored yet never counts.
    expect(d.map((c) => c.field).sort()).toEqual(['cover', 'identifiers', 'series_index']);
  });

  it('refuses names Calibre can’t make and "&" in a name', () => {
    expect(checkNames(5, '短い', '作者').ok).toBe(true);
    expect(checkNames(5, '長'.repeat(90), '作者').ok).toBe(false);
    expect(() => normalizeValue('authors', ['A & B'])).toThrow(/splits a name/);
    expect(normalizeValue('authors', ['A ＆ B'])).toEqual(['A ＆ B']);
    expect(normalizeValue('pubdate', '2024-05-01')).toBe(Date.UTC(2024, 4, 1, 12));
    expect(() => normalizeValue('pubdate', '2024-02-30')).toThrow(/real date/);
    expect(normalizeValue('series', { name: 'S', index: '3.5' })).toEqual({
      name: 'S',
      index: 3.5,
    });
    expect(normalizeValue('rating', 9)).toBe(9);
    expect(() => normalizeValue('rating', 11)).toThrow();
    expect(userKeysOf('series', { name: 'S', index: 1 }, { name: 'S', index: 2 })).toEqual([
      'series_index',
    ]);
  });

  it('finds the series name pair by the report’s rule, シリーズ first, never a decided one', () => {
    const all = [
      { name: '本好きの下剋上', books: 30 },
      { name: '本好きの下剋上 ～司書になるためには手段を選んでいられません～', books: 20 },
      { name: '百夜・百鬼夜行帖シリーズ', books: 46 },
      { name: '百夜・百鬼夜行帖', books: 46 },
      { name: '本', books: 3 },
    ];
    expect(seriesPairsOf('百夜・百鬼夜行帖', all, new Set()).map((p) => p.name)).toEqual([
      '百夜・百鬼夜行帖シリーズ',
    ]);
    expect(seriesPairsOf('本好きの下剋上', all, new Set())[0]).toMatchObject({
      name: '本好きの下剋上 ～司書になるためには手段を選んでいられません～',
      onlySeries: false,
    });
    expect(
      seriesPairsOf(
        '本好きの下剋上',
        all,
        new Set(['本好きの下剋上 ～司書になるためには手段を選んでいられません～']),
      ),
    ).toEqual([]);
  });

  it('the web app’s byte counter is the server’s naming rule (same answers)', async () => {
    const web = await import('../../web/src/lib/calibre-edit/names');
    const { calibreNameBytes } = await import('../src/cleanup/calibre-names');
    const cases: [number, string, string][] = [
      [5, '短い', '作者'],
      [48213, '月と灯台３ ～潮騒の夜に～', '水瀬 葵'],
      [7, '長'.repeat(83), '作者'],
      [1234567, '  The Book. ', 'A. B. '],
      [12, 'x'.repeat(300), 'y'.repeat(300)],
      [99, '😀'.repeat(40), '\uD800 lone'],
    ];
    for (const [id, t, a] of cases)
      expect(web.calibreNameBytes(id, t, a), `${id} ${t}`).toBe(calibreNameBytes(id, t, a));
  });

  it('tells a case-only rename of a shared name', () => {
    expect(caseOnlyRenames(['abc def', 'X'], ['Abc Def', 'X'])).toEqual([
      { from: 'abc def', to: 'Abc Def' },
    ]);
    expect(caseOnlyRenames(['abc'], ['abd'])).toBeNull();
  });
});

describe('the user’s edits through the apply sidecar', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let log: string;
  let ids: Record<string, number>;
  let user: string;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    ids = {
      A: await env.lib.addBook({
        title: '古い題名',
        authors: ['古い作者'],
        cover: 'jpeg',
        comments: 'あらすじ',
        series: { name: 'テスト', index: 1 },
        epub: makeMetaEpub({ title: '古い題名', creators: [{ name: '古い作者', role: 'aut' }] }),
      }),
      B: await env.lib.addBook({
        title: '二巻',
        authors: ['古い作者'],
        cover: 'none',
        series: { name: 'テスト', index: 2 },
        epub: makeMetaEpub({ title: '二巻', creators: [{ name: '古い作者', role: 'aut' }] }),
      }),
      C: await env.lib.addBook({
        title: '別シリーズの本',
        authors: ['別の作者'],
        cover: 'none',
        series: { name: 'テストシリーズ', index: 4 },
        epub: makeMetaEpub({
          title: '別シリーズの本',
          creators: [{ name: '別の作者', role: 'aut' }],
        }),
      }),
    };
    for (let i = 0; i < 10; i++)
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
    quarantine = makeTempDir('quarantine');
    log = path.join(makeTempDir('log'), 'calls.log');
    user = env.userToken();
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
          lookupChunk: 1,
        },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
    workerUrl = `http://127.0.0.1:${port}`;
  });
  let workerUrl = '';

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker() {
    const config: SidecarConfig = {
      serverUrl: workerUrl,
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

  async function runAll(w: Worker) {
    for (let i = 0; i < 20; i++) {
      const r = await w.cycle();
      if (r === 'idle' && !env.service.batches.open()) return;
    }
  }

  const book = (calibreId: number) => env.readerBook(uuidOf(calibreId))!.bookId;
  const uuidOf = (calibreId: number) => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return (db.prepare('SELECT uuid FROM books WHERE id = ?').get(calibreId) as { uuid: string })
        .uuid;
    } finally {
      db.close();
    }
  };
  const libRow = (sql: string, id: number) => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return db.prepare(sql).get(id) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  };

  it('writes every field of a save, verified, and the page sees it once indexed', async () => {
    const id = book(ids.A);
    const form = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .expect(200);
    expect(form.body.values).toMatchObject({ title: '古い題名', authors: ['古い作者'] });
    const saved = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({
        base: form.body.values,
        values: {
          title: '新しい題名',
          sort: 'あたらしいだいめい',
          authors: ['新しい作者'],
          author_sort: 'アタラシイサクシャ',
          pubdate: '2024-05-01',
          rating: 9,
          tags: ['ファンタジー', '麻雀'],
          identifiers: { amazon_jp: 'B0TEST' },
          publisher: '出版社',
          languages: ['jpn'],
          description: '一段落目。\n\n二段落目。',
          series: { name: 'テスト', index: 1.5 },
        },
      })
      .expect(200);
    expect(saved.body.batchId).toBeTruthy();
    // No metadata.db copy first: the edit is ready to write at once.
    const b = env.service.batches.get(saved.body.batchId)!;
    expect(b).toMatchObject({ stage: EDIT_STAGE, snapshotSaved: true, state: 'planned' });
    expect(saved.body.status.every((s: { state: string }) => s.state === 'waiting')).toBe(true);
    await runAll(worker());
    const r = calibreRecord(env.lib, ids.A)!;
    expect(r).toMatchObject({
      title: '新しい題名',
      authors: ['新しい作者'],
      authorSort: 'アタラシイサクシャ',
      identifiers: { amazon_jp: 'B0TEST' },
      publisher: '出版社',
      languages: ['jpn'],
    });
    expect(libRow('SELECT sort, pubdate FROM books WHERE id = ?', ids.A)).toMatchObject({
      sort: 'あたらしいだいめい',
      pubdate: '2024-05-01 12:00:00+00:00',
    });
    expect(
      libRow(
        'SELECT r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating WHERE l.book = ?',
        ids.A,
      ),
    ).toEqual({ rating: 9 });
    expect(env.service.batches.get(saved.body.batchId)!.state).toBe('applied');
    // Written, then shown once the reader's index has read Calibre again.
    const st1 = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/status`)
      .set(auth(user));
    expect(st1.body.status.find((s: { field: string }) => s.field === 'title').state).toBe(
      'written',
    );
    await env.index();
    const st2 = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/status`)
      .set(auth(user));
    expect(new Set(st2.body.status.map((s: { state: string }) => s.state))).toEqual(
      new Set(['shown']),
    );
    const detail = await request(env.app).get(`/api/v1/books/${id}`).set(auth(user)).expect(200);
    expect(detail.body).toMatchObject({ title: '新しい題名', rating: 9, languages: ['jpn'] });
    // The index saw the writes: they are the edit's, not "Changed in Calibre".
    env.service.sortChanges();
    await new Promise((res) => setTimeout(res, 50));
    expect(env.cleanupDb.prepare('SELECT COUNT(*) n FROM calibre_seen_changes').get()).toEqual({
      n: 0,
    });
    expect(env.db.prepare('SELECT COUNT(*) n FROM calibre_field_changes').get()).toEqual({ n: 0 });
  });

  it('a second save before the library shows the first starts from what the user saved', async () => {
    const id = book(ids.A);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { rating: 9 } })
      .expect(200);
    // Not written or indexed yet: the form shows 9 and Clear is a change.
    const form = await request(env.app).get(`/api/v1/books/${id}/calibre-edit`).set(auth(user));
    expect(form.body.values.rating).toBe(9);
    const clear = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { rating: null } })
      .expect(200);
    expect(clear.body.changed).toEqual(['rating']);
  });

  it('refuses a title too long for Calibre’s folders and a name with "&"', async () => {
    const id = book(ids.A);
    const long = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { title: '長'.repeat(100) } })
      .expect(422);
    expect(long.body.error).toMatchObject({ code: 'title_too_long', max: 255 });
    const amp = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { authors: ['A & B'] } })
      .expect(422);
    expect(amp.body.error.code).toBe('split_name');
    expect(env.service.batches.open()).toBeNull();
  });

  it('asks first when a case-only change renames a name other books share', async () => {
    const id = book(ids.A);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({
        values: { series: { name: 'テスト', index: 1 }, authors: ['棚の作者'.toUpperCase()] },
      })
      .expect(200); // Japanese has no case: nothing shared renamed
    await request(env.app)
      .post(`/api/v1/books/${book(ids.B)}/calibre-edit`)
      .set(auth(user))
      .send({ values: { tags: [] } })
      .expect(200);
    const c = book(ids.C);
    env.db
      .prepare(`INSERT OR IGNORE INTO tags (name, name_fold) VALUES ('shared tag', 'shared tag')`)
      .run();
    const t = env.db.prepare(`SELECT id FROM tags WHERE name = 'shared tag'`).get() as {
      id: number;
    };
    env.db.prepare('INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?)').run(book(ids.B), t.id);
    const ask = await request(env.app)
      .post(`/api/v1/books/${c}/calibre-edit`)
      .set(auth(user))
      .send({ values: { tags: ['Shared Tag'] } })
      .expect(409);
    expect(ask.body.error).toMatchObject({ code: 'shared_rename' });
    expect(ask.body.error.renames[0]).toMatchObject({
      from: 'shared tag',
      to: 'Shared Tag',
      books: 1,
    });
    await request(env.app)
      .post(`/api/v1/books/${c}/calibre-edit`)
      .set(auth(user))
      .send({ values: { tags: ['Shared Tag'] }, acceptRenames: true })
      .expect(200);
  });

  it('goes ahead of queued cleanup batches, and between the chunks of a running one', async () => {
    const uuid = uuidOf(ids.B);
    const put = env.cleanupDb.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, 'description', 'null', ?, 'test', '{}', 'auto', 'proposed', 'a4', 1, 1)`,
    );
    put.run(env.libraryId(), ids.B, uuid, JSON.stringify('段落'));
    const queued = env.service.batches.createBatch(4, env.libraryId(), 'apply', null, [
      Number(
        (env.cleanupDb.prepare('SELECT max(id) id FROM proposed_changes').get() as { id: number })
          .id,
      ),
    ]);
    env.cleanupDb
      .prepare('UPDATE batches SET snapshot_saved = 1, snapshot_sha256 = ? WHERE id = ?')
      .run('x', queued.id);
    await request(env.app)
      .post(`/api/v1/books/${book(ids.A)}/calibre-edit`)
      .set(auth(user))
      .send({ values: { title: '先に書く' } })
      .expect(200);
    // The sidecar's version is known from its heartbeat; an edit is claimed first.
    const w = worker();
    await w.cycle();
    expect(calibreRecord(env.lib, ids.A)!.title).toBe('先に書く');
    expect(env.service.batches.get(queued.id)!.state).toBe('planned');
    // Between chunks: the sidecar asks for edits only.
    await request(env.app)
      .post(`/api/v1/books/${book(ids.C)}/calibre-edit`)
      .set(auth(user))
      .send({ values: { title: 'あいだに書く' } })
      .expect(200);
    const claim = await env.service.batches.claim(Date.now(), { editsOnly: true });
    expect(claim.batch?.stage).toBe(EDIT_STAGE);
    env.cleanupDb
      .prepare(`UPDATE batches SET state = 'planned', lease_expires_at = NULL WHERE id = ?`)
      .run(claim.batch!.id);
    await w.editsBetween();
    expect(calibreRecord(env.lib, ids.C)!.title).toBe('あいだに書く');
    expect(env.service.batches.get(queued.id)!.state).toBe('planned');
  });

  it('a field the user edited is never proposed or written by the cleanup again', async () => {
    const id = book(ids.B);
    const uuid = uuidOf(ids.B);
    // A cleanup proposal already open for the title, and one for the description.
    const put = env.cleanupDb.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, ?, ?, ?, 'test', '{}', 'auto', 'proposed', 'a4', 1, 1)`,
    );
    put.run(
      env.libraryId(),
      ids.B,
      uuid,
      'title',
      JSON.stringify('二巻'),
      JSON.stringify('二巻 (cleanup)'),
    );
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { title: '二巻 自分の題名' } })
      .expect(200);
    const state = (f: string) =>
      env.cleanupDb
        .prepare(
          `SELECT state, review_reason FROM proposed_changes WHERE stage = 4 AND calibre_uuid = ? AND field = ? ORDER BY id DESC`,
        )
        .get(uuid, f) as { state: string; review_reason: string };
    expect(state('title')).toMatchObject({
      state: 'skipped',
      review_reason: expect.stringMatching(/^Yours/),
    });
    // A later proposal for it is set aside at once (any stage, new arrivals included).
    put.run(env.libraryId(), ids.B, uuid, 'title', JSON.stringify('二巻'), JSON.stringify('again'));
    expect(state('title').state).toBe('skipped');
    put.run(env.libraryId(), ids.B, uuid, 'description', 'null', JSON.stringify('あらすじ'));
    expect(state('description').state).toBe('proposed');
    // The stage-4 AI's value of the title is the user's once written.
    await runAll(worker());
    expect(
      env.cleanupDb
        .prepare(
          `SELECT source, flagged FROM ai_values WHERE stage = 'calibre4' AND item_key = ? AND field = 't'`,
        )
        .get(`${env.libraryId()}:${uuid}`),
    ).toEqual({ source: 'user', flagged: 0 });
  });

  it('a field changed in Calibre’s own program becomes the user’s, with a history entry', async () => {
    const id = book(ids.A);
    env.lib.setTitle(ids.A, 'Calibreで直した題名');
    await env.index();
    env.service.sortChanges();
    await new Promise((res) => setTimeout(res, 50));
    const seen = env.cleanupDb
      .prepare('SELECT field, kind, new_json FROM calibre_seen_changes')
      .all();
    expect(seen).toEqual([
      { field: 'title', kind: 'calibre', new_json: JSON.stringify('Calibreで直した題名') },
    ]);
    expect(
      env.cleanupDb
        .prepare('SELECT field, source FROM user_fields WHERE calibre_uuid = ?')
        .all(uuidOf(ids.A)),
    ).toEqual([{ field: 'title', source: 'calibre' }]);
    const h = await request(env.app).get(`/api/v1/books/${id}/history`).set(auth(user)).expect(200);
    expect(h.body.entries[0]).toMatchObject({
      who: 'calibre',
      field: 'title',
      undo: { possible: true },
    });
  });

  it('the history’s Undo writes the old value back (asked on the page) and becomes the user’s', async () => {
    const id = book(ids.A);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { title: '一度目' } })
      .expect(200);
    const w = worker();
    await runAll(w);
    await env.index();
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ values: { description: '新しい' } })
      .expect(200);
    await runAll(w);
    await env.index();
    const h = await request(env.app).get(`/api/v1/books/${id}/history`).set(auth(user)).expect(200);
    const title = h.body.entries.find((e: { field: string }) => e.field === 'title');
    expect(title).toMatchObject({
      who: 'you',
      old: '古い題名',
      new: '一度目',
      undo: { possible: true },
    });
    await request(env.app)
      .post(`/api/v1/books/${id}/history/${title.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    await env.index();
    expect(calibreRecord(env.lib, ids.A)!.title).toBe('古い題名');
    const h2 = await request(env.app)
      .get(`/api/v1/books/${id}/history`)
      .set(auth(user))
      .expect(200);
    const after = h2.body.entries.filter((e: { field: string }) => e.field === 'title');
    expect(after[0]).toMatchObject({
      who: 'you',
      via: 'undo',
      new: '古い題名',
      undo: { possible: true },
    });
    expect(after[1]).toMatchObject({ id: title.id, state: 'undone', undo: { possible: false } });
    // An entry whose field changed since can't be undone (the description's is the latest).
    await request(env.app)
      .post(`/api/v1/books/${id}/history/${title.id}/undo`)
      .set(auth(user))
      .expect(409);
  });

  it('a cover from an uploaded picture, with the old one kept for Undo', async () => {
    const id = book(ids.A);
    const pic = await makeJpeg(200);
    const up = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit/cover`)
      .set(auth(user))
      .set('Content-Type', 'image/jpeg')
      .send(pic)
      .expect(200);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit/cover`)
      .set(auth(user))
      .set('Content-Type', 'text/plain')
      .send('not a picture')
      .expect(415);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ coverToken: up.body.token })
      .expect(200);
    const before = calibreCover(ids.A);
    await runAll(worker());
    expect(calibreCover(ids.A).equals(pic)).toBe(true);
    // Book covers: Calibre's picture is kept in the server's own archive, not the quarantine.
    const undo = env.cleanupDb
      .prepare(`SELECT change_id, old_cover_path FROM field_undo WHERE field = 'cover'`)
      .get() as { change_id: number; old_cover_path: string | null };
    expect(undo.old_cover_path).toBeNull();
    expect(quarantinePictures()).toEqual([]);
    const kept = env.service.coverArchive.keptBefore(undo.change_id)!;
    expect(fs.readFileSync(env.service.coverArchive.file(kept)!).equals(before)).toBe(true);
  });

  /** Cover pictures the sidecar kept in its quarantine (batch.json records aside). */
  const quarantinePictures = (): string[] =>
    (fs.readdirSync(quarantine, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('old-cover.jpg'),
    );

  /** Calibre's cover.jpg of a book as it is now. */
  const calibreCover = (calibreId: number) => {
    const r = calibreRecord(env.lib, calibreId)!;
    return fs.readFileSync(path.join(env.lib.dir, ...r.path.split('/'), 'cover.jpg'));
  };

  async function newCover(id: string, pic: Buffer, w: Worker) {
    const up = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit/cover`)
      .set(auth(user))
      .set('Content-Type', 'image/jpeg')
      .send(pic)
      .expect(200);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ coverToken: up.body.token })
      .expect(200);
    await runAll(w);
    await env.index();
  }

  it('book covers: three changes, then the original and the second put back byte for byte', async () => {
    const id = book(ids.A);
    const w = worker();
    const original = calibreCover(ids.A);
    const second = await patterned(1);
    const third = await patterned(5);
    await newCover(id, second, w);
    await newCover(id, third, w);
    expect(calibreCover(ids.A).equals(third)).toBe(true);
    const list = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/covers`)
      .set(auth(user))
      .expect(200);
    // The original, the second (kept before the third; also seen after its own write) and the
    // third (seen after its write: the cover now).
    expect(list.body.covers).toHaveLength(3);
    expect(list.body.covers.map((c: { current: boolean }) => c.current)).toEqual([
      false,
      false,
      true,
    ]);
    const shaOriginal = list.body.covers[0].sha256 as string;
    const pic = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/covers/${shaOriginal}`)
      .set(auth(user))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((pic.body as Buffer).equals(original)).toBe(true);
    // Another book can't read or use this book's pictures.
    await request(env.app)
      .get(`/api/v1/books/${book(ids.B)}/calibre-edit/covers/${shaOriginal}`)
      .set(auth(user))
      .expect(404);
    // Pick the original: kept for the next save like an upload, then saved.
    const use = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit/covers/${shaOriginal}/use`)
      .set(auth(user))
      .expect(200);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ coverToken: use.body.token })
      .expect(200);
    await runAll(w);
    await env.index();
    expect(calibreCover(ids.A).equals(original)).toBe(true);
    // The history's Undo of that change puts the third back (from the archive).
    const h = await request(env.app).get(`/api/v1/books/${id}/history`).set(auth(user)).expect(200);
    const latest = h.body.entries.find((e: { field: string }) => e.field === 'cover');
    expect(latest).toMatchObject({ who: 'you', undo: { possible: true } });
    await request(env.app)
      .post(`/api/v1/books/${id}/history/${latest.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    expect(calibreCover(ids.A).equals(third)).toBe(true);
    // The sidecar's quarantine was never used for any of it.
    expect(quarantinePictures()).toEqual([]);
  });

  it('book covers: the same picture at another size stays pickable, marked as a look-alike', async () => {
    // Found live 2026-11-25 (吾輩は猫である): the earlier 1549 × 2200 picture beside the
    // 1803 × 2560 cover now was taken for "now" and the Earlier covers row was hidden.
    const id = book(ids.A);
    const w = worker();
    const big = await patterned(3);
    const small = await sharp(big).resize(400, 600).jpeg().toBuffer();
    await newCover(id, small, w);
    await newCover(id, big, w);
    const list = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/covers`)
      .set(auth(user))
      .expect(200);
    const rows = list.body.covers as {
      width: number;
      current: boolean;
      same: boolean;
    }[];
    expect(rows.filter((c) => c.current).map((c) => c.width)).toEqual([600]);
    const smaller = rows.find((c) => c.width === 400)!;
    expect(smaller).toMatchObject({ current: false, same: true });
    // The original (a different picture) is neither.
    expect(rows[0]).toMatchObject({ current: false, same: false });
  });

  it('book covers: a cover changed in Calibre’s own program is kept too', async () => {
    const id = book(ids.A);
    await env.lib.setCover(ids.A, 150);
    // (a flat picture: the archive keeps it whatever it looks like)
    await env.index();
    env.service.sortChanges();
    for (let i = 0; i < 50; i++) {
      await new Promise((res) => setTimeout(res, 20));
      if (
        env.service.coverArchive.list({
          libraryId: env.readerBook(uuidOf(ids.A))!.libraryId,
          uuid: uuidOf(ids.A),
        }).length
      )
        break;
    }
    const list = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/covers`)
      .set(auth(user))
      .expect(200);
    expect(list.body.covers).toHaveLength(1);
    expect(list.body.covers[0].current).toBe(true);
    expect(env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM cover_archive_wanted').get()).toEqual({
      n: 0,
    });
  });

  it('book covers: the cover is not replaced when Calibre’s picture can’t be kept', async () => {
    const id = book(ids.A);
    const dir = (env.service.coverArchive as unknown as { dir: string }).dir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'a file where the folder should be');
    const before = calibreCover(ids.A);
    const up = await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit/cover`)
      .set(auth(user))
      .set('Content-Type', 'image/jpeg')
      .send(await makeJpeg(90))
      .expect(200);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ coverToken: up.body.token })
      .expect(200);
    await runAll(worker());
    expect(calibreCover(ids.A).equals(before)).toBe(true);
    const st = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit/status`)
      .set(auth(user))
      .expect(200);
    expect(st.body.status.find((s: { field: string }) => s.field === 'cover')).toMatchObject({
      state: 'not_written',
      reason: expect.stringMatching(
        /^Calibre's current cover couldn't be kept, so it wasn't replaced/,
      ),
    });
    fs.rmSync(dir, { force: true });
  });

  it('book covers: the quarantine’s earlier covers are imported once by the sidecar’s program', async () => {
    const id = book(ids.A);
    await newCover(id, await makeJpeg(60), worker());
    // As a write made before the archive: its earlier picture only in the quarantine.
    const row = env.cleanupDb
      .prepare(`SELECT change_id FROM field_undo WHERE field = 'cover'`)
      .get() as { change_id: number };
    const kept = env.service.coverArchive.keptBefore(row.change_id)!;
    const oldPic = fs.readFileSync(env.service.coverArchive.file(kept)!);
    env.cleanupDb.prepare('DELETE FROM cover_archive').run();
    const qFile = path.join(quarantine, 'batch-x', String(ids.A), 'old-cover.jpg');
    fs.mkdirSync(path.dirname(qFile), { recursive: true });
    fs.writeFileSync(qFile, oldPic);
    env.cleanupDb
      .prepare(`UPDATE field_undo SET old_cover_path = ? WHERE change_id = ?`)
      .run(qFile, row.change_id);
    // One more whose file is gone, and one outside the quarantine (never read).
    const sidecarEnv = {
      TTSU_URL: workerUrl,
      CLEANUP_TOKEN: env.applyToken(),
      QUARANTINE_DIR: quarantine,
    };
    const lines: string[] = [];
    const r1 = await importCovers(sidecarEnv, fetch, (l) => lines.push(l));
    expect(r1).toEqual({ kept: 1, missing: 0, failed: 0, total: 1 });
    expect(env.service.coverArchive.keptBefore(row.change_id)).toBe(kept);
    // The quarantine is untouched, and a second run finds nothing left to do.
    expect(fs.readFileSync(qFile).equals(oldPic)).toBe(true);
    expect(await importCovers(sidecarEnv, fetch, () => {})).toEqual({
      kept: 0,
      missing: 0,
      failed: 0,
      total: 0,
    });
    // The history's Undo now reads it from the archive.
    const h = await request(env.app).get(`/api/v1/books/${id}/history`).set(auth(user)).expect(200);
    const e = h.body.entries.find((x: { field: string }) => x.field === 'cover');
    expect(e).toMatchObject({ undo: { possible: true, to: { archive: kept } } });
  });

  it('book covers: the import refuses a picture that arrived incomplete', async () => {
    await newCover(book(ids.A), await makeJpeg(70), worker());
    const row = env.cleanupDb
      .prepare(`SELECT change_id FROM field_undo WHERE field = 'cover'`)
      .get() as { change_id: number };
    env.cleanupDb.prepare('DELETE FROM cover_archive').run();
    env.cleanupDb
      .prepare(
        `UPDATE field_undo SET old_cover_path = '/quarantine/x/old-cover.jpg' WHERE change_id = ?`,
      )
      .run(row.change_id);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/cover-archive/quarantine/${row.change_id}`)
      .set(auth(env.applyToken()))
      .set('Content-Type', 'application/octet-stream')
      .set('x-sha256', '0'.repeat(64))
      .send(await makeJpeg(70))
      .expect(422);
    // Only the sidecar's token reaches these routes.
    await request(env.app)
      .get('/api/v1/cleanup-apply/cover-archive/quarantine')
      .set(auth(user))
      .expect(401);
  });

  it('the series editor renames, renumbers and merges its pair in one batch', async () => {
    const view = await request(env.app)
      .get('/api/v1/calibre-series')
      .query({ name: 'テスト' })
      .set(auth(user))
      .expect(200);
    expect(view.body.books.map((b: { title: string }) => b.title)).toEqual(['古い題名', '二巻']);
    expect(view.body.pairs[0]).toMatchObject({ name: 'テストシリーズ', onlySeries: true });
    const save = await request(env.app)
      .post('/api/v1/calibre-series')
      .set(auth(user))
      .send({
        name: 'テスト',
        rename: 'テスト２',
        books: [{ bookId: book(ids.B), base: { index: 2 }, index: 2.5 }],
        merge: 'テストシリーズ',
      })
      .expect(200);
    expect(save.body.books).toBe(3);
    await runAll(worker());
    const series = (id: number) =>
      libRow(
        'SELECT s.name, b.series_index AS idx FROM books b JOIN books_series_link l ON l.book = b.id JOIN series s ON s.id = l.series WHERE b.id = ?',
        id,
      );
    expect(series(ids.A)).toEqual({ name: 'テスト２', idx: 1 });
    expect(series(ids.B)).toEqual({ name: 'テスト２', idx: 2.5 });
    expect(series(ids.C)).toEqual({ name: 'テスト２', idx: 4 });
    // "Not the same series" is kept.
    await request(env.app)
      .post('/api/v1/calibre-series/not-same')
      .set(auth(user))
      .send({ name: 'テスト２', other: 'テスト２ 外伝' })
      .expect(200);
  });

  it('confirm as right: the value stays and leaves the best guesses', async () => {
    const id = book(ids.B);
    const key = `${env.libraryId()}:${uuidOf(ids.B)}`;
    env.cleanupDb
      .prepare(
        `INSERT INTO ai_values (stage, item_key, field, value_json, source, flagged, reason, decided_at)
         VALUES ('calibre4', ?, 'ix', '{"n":2}', 'secondary_guess', 1, 'A best guess', 1)`,
      )
      .run(key);
    const form = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .expect(200);
    expect(form.body.unconfirmed).toEqual([{ field: 'series_index', reason: 'A best guess' }]);
    await request(env.app)
      .post(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .send({ confirm: ['series_index'] })
      .expect(200);
    const form2 = await request(env.app)
      .get(`/api/v1/books/${id}/calibre-edit`)
      .set(auth(user))
      .expect(200);
    expect(form2.body.unconfirmed).toEqual([]);
    expect(env.service.batches.open()).toBeNull();
    expect(
      env.cleanupDb
        .prepare(`SELECT source, flagged FROM ai_values WHERE item_key = ? AND field = 'ix'`)
        .get(key),
    ).toEqual({ source: 'user', flagged: 0 });
  });

  it('the tag list: one change at a time, nothing written to books', async () => {
    const t = await request(env.app).get('/api/v1/calibre-tags').set(auth(user)).expect(200);
    expect(t.body.groups.map((g: { id: string }) => g.id)).toEqual([
      'format',
      'genre',
      'subject',
      'tag',
      'adaptation',
      'yours',
    ]);
    expect(t.body.groups[1].tags).toHaveLength(22);
    const added = await request(env.app)
      .put('/api/v1/calibre-tags')
      .set(auth(user))
      .send({ group: 'tag', add: '麻雀' })
      .expect(200);
    expect(added.body.groups[3].tags.map((x: { label: string }) => x.label)).toContain('麻雀');
    await request(env.app)
      .put('/api/v1/calibre-tags')
      .set(auth(user))
      .send({ group: 'tag', add: '麻雀' })
      .expect(422);
    expect(env.service.batches.open()).toBeNull();
  });

  it('the hot queries use their indexes (no scan of a table that grows with the library)', () => {
    const plan = (sql: string, ...a: unknown[]) =>
      (env.cleanupDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    const status = plan(
      `SELECT p.id FROM proposed_changes p INDEXED BY proposed_changes_book
       LEFT JOIN batches b ON b.id = p.batch_id LEFT JOIN field_undo f ON f.change_id = p.id
       WHERE p.library_id = ? AND p.calibre_uuid = ? AND p.stage = 10 AND p.created_at > ?`,
      'l',
      'u',
      0,
    );
    expect(status).not.toMatch(/SCAN (p|b|f|proposed_changes|field_undo|batches)\b/);
    expect(
      plan(
        'SELECT 1 FROM user_fields WHERE library_id = ? AND calibre_uuid = ? AND field IN (?, ?)',
        'l',
        'u',
        'a',
        'b',
      ),
    ).toMatch(/SEARCH/);
    expect(
      plan('SELECT 1 FROM undo_records WHERE library_id = ? AND kept_uuid = ?', 'l', 'u'),
    ).toMatch(/undo_records_kept/);
    expect(
      plan(
        'SELECT 1 FROM calibre_seen_changes WHERE library_id = ? AND calibre_uuid = ?',
        'l',
        'u',
      ),
    ).toMatch(/calibre_seen_changes_book/);
  });
});
