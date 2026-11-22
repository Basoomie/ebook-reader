/**
 * WP20g: the Calibre library's new arrivals and the import from the torrents folders.
 *
 * Unit: file kinds and formats, the settle rule, the pairs' settings, archive entries, the add
 * batches (lease, steps, never added twice, Undo), the sidecar's add allowlist, J for stage 4.
 * End to end on a synthetic library with a temp source folder (the reader's real import code
 * in-process): a Preview run (identical file, same text, a new book, an archive's EPUB, other
 * formats, a download in progress), the first run's approval, On with the sidecar's steps
 * played through its routes, the run's books through stages 1-2, a book added by hand that is a
 * copy, and a book you removed never added again.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildArgs } from '../../cleanup-apply/src/calibredb';
import { ArrivalBatches } from '../src/cleanup/arrivals/add-batches';
import { entrySkip } from '../src/cleanup/arrivals/archives';
import { classifyName, settled, sniffFormat, walkSource } from '../src/cleanup/arrivals/catalog';
import { runBar } from '../src/cleanup/arrivals/views';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { arrivalPairs, getSettings, SettingsError, updateSettings } from '../src/cleanup/settings';
import { stage4NeedsUpgrade } from '../src/cleanup/stage4/ai-decide';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { healthyHeartbeat, makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { makeZip } from './helpers/epub-fixture';
import { chaptersOf, makeTextEpub } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-wp20g-'));

describe('wp20g: files and formats', () => {
  it('tells EPUBs, other book formats, archives, volumes, downloads and the rest apart', () => {
    expect(classifyName('a/b/c.epub').kind).toBe('epub');
    expect(classifyName('x.kepub.EPUB').kind).toBe('epub');
    expect(classifyName('x.azw3')).toMatchObject({ kind: 'book', format: 'AZW3' });
    expect(classifyName('x.pdf')).toMatchObject({ kind: 'book', format: 'PDF' });
    expect(classifyName('x.cbz').kind).toBe('book');
    expect(classifyName('Kindle/B00ABC')).toMatchObject({ kind: 'book', sniff: true });
    expect(classifyName('a.zip').kind).toBe('archive');
    expect(classifyName('a.rar').kind).toBe('archive');
    expect(classifyName('a.7z.001')).toMatchObject({ kind: 'archive', format: 'split set' });
    expect(classifyName('a.7z.002').kind).toBe('volume');
    expect(classifyName('a.epub.!qB').kind).toBe('partial');
    expect(classifyName('a.epub.part').kind).toBe('partial');
    expect(classifyName('a.parts').kind).toBe('partial');
    expect(classifyName('a.mp3').kind).toBe('other');
    expect(classifyName('a.opf').kind).toBe('other');
    expect(classifyName('deck.anki').kind).toBe('other');
  });

  it('reads the format of a file without an extension from its first bytes', () => {
    const mobi = Buffer.alloc(80);
    mobi.write('BOOKMOBI', 60, 'latin1');
    expect(sniffFormat(mobi)).toBe('no extension (MOBI by content)');
    expect(sniffFormat(Buffer.from('%PDF-1.4'))).toBe('no extension (PDF by content)');
    const epub = makeTextEpub({ title: 'x', chapters: ['あ'.repeat(10)] });
    expect(sniffFormat(epub.subarray(0, 68))).toBe('no extension (EPUB by content)');
    expect(sniffFormat(Buffer.from('hello'))).toBe('no extension');
    expect(sniffFormat(null)).toBe('no extension (empty)');
  });

  it('counts a file once its size and mtime were unchanged for the settle time', () => {
    const now = 10_000_000;
    expect(
      settled({ first_seen_at: now - 31 * 60_000, mtime_ms: now - 40 * 60_000 }, now, 30 * 60_000),
    ).toBe(true);
    // Seen long ago but modified a minute ago (a new version would be seen first).
    expect(
      settled({ first_seen_at: now - 60 * 60_000, mtime_ms: now - 60_000 }, now, 30 * 60_000),
    ).toBe(false);
    // An old file first seen just now.
    expect(settled({ first_seen_at: now - 60_000, mtime_ms: now - 9e6 }, now, 30 * 60_000)).toBe(
      false,
    );
  });

  it('never unpacks unsafe or hidden archive entries', () => {
    expect(entrySkip('a/b.epub')).toBeNull();
    expect(entrySkip('../b.epub')).toBe('leaves the folder');
    expect(entrySkip('/etc/b.epub')).toBe('absolute path');
    expect(entrySkip('__MACOSX/._b.epub')).toBe('macOS extra');
    expect(entrySkip('.hidden/b.epub')).toBe('hidden');
  });

  it('checks the source folders set in the settings', () => {
    expect(arrivalPairs([{ id: 'ja', source: 'books\\japanese/', libraryId: 'L' }])).toEqual([
      { id: 'ja', source: 'books/japanese', libraryId: 'L' },
    ]);
    expect(() =>
      arrivalPairs([{ id: 'a', source: 'audiobooks/japanese', libraryId: 'L' }]),
    ).toThrow(SettingsError);
    expect(() => arrivalPairs([{ id: 'a', source: 'books/../x', libraryId: 'L' }])).toThrow(
      SettingsError,
    );
    expect(() => arrivalPairs([{ id: 'a', source: 'books/_extracted', libraryId: 'L' }])).toThrow(
      SettingsError,
    );
    expect(() =>
      arrivalPairs([
        { id: 'a', source: 'books', libraryId: 'L' },
        { id: 'b', source: 'books/japanese', libraryId: 'L' },
      ]),
    ).toThrow(/overlap/);
    expect(() => arrivalPairs([{ id: 'a b', source: 'books', libraryId: 'L' }])).toThrow(
      SettingsError,
    );
  });

  it('the apply sidecar adds only one arrival EPUB from its own folder (or Undo’s re-add)', () => {
    const login = {
      contentServerUrl: 'http://c:8083',
      libraryId: 'lib',
      username: 'u',
      password: 'p',
    };
    expect(
      buildArgs('add', login, ['--duplicates', '/tmp/ttsu-arrivals/ttsu-arrival-12/b.epub']),
    ).toContain('/tmp/ttsu-arrivals/ttsu-arrival-12/b.epub');
    expect(() => buildArgs('add', login, ['--duplicates', '/tmp/other/b.epub'])).toThrow();
    expect(() => buildArgs('add', login, ['/tmp/ttsu-arrivals/ttsu-arrival-12/b.epub'])).toThrow();
    expect(() =>
      buildArgs('add', login, [
        '--duplicates',
        '/tmp/ttsu-arrivals/ttsu-arrival-12/b.epub',
        '/x.epub',
      ]),
    ).toThrow();
    expect(() =>
      buildArgs('add', login, ['-m', 'ignore', '/tmp/ttsu-arrivals/ttsu-arrival-1/b.epub']),
    ).toThrow();
    expect(() =>
      buildArgs('add', login, ['--duplicates', '--one-book-per-directory', '/quarantine/x/12']),
    ).not.toThrow();
  });

  it('J asks the stronger pair where E left a field open or flagged', () => {
    const f = (source: string, flagged = false) => ({
      decision: { value: 'x', source, flagged, reason: null },
      rules: { value: 'x', auto: true },
      primary: 'x',
      secondary: 'x',
    });
    const all = (o: Record<string, unknown>) =>
      ({
        t: f('rules'),
        au: f('rules'),
        il: f('rules'),
        se: f('rules'),
        ix: f('rules'),
        fmt: f('rules'),
        amazonIsBook: false,
        invented: 0,
        ...o,
      }) as never;
    expect(stage4NeedsUpgrade(all({}), 'J')).toBe(false);
    expect(stage4NeedsUpgrade(all({ se: f('both_models') }), 'J')).toBe(true);
    expect(stage4NeedsUpgrade(all({ se: f('both_models') }), 'F')).toBe(false);
    expect(stage4NeedsUpgrade(all({ il: f('secondary_guess', true) }), 'F')).toBe(true);
  });

  it('the run bar measures the time left from the phase’s own pace', () => {
    const now = 1_000_000;
    const bar = runBar(
      {
        phase: 'identify',
        phaseStartedAt: now - 60_000,
        phaseStartDone: 0,
        counts: { identify: { done: 10, total: 40, bytesDone: 100, bytesTotal: 400 } },
      } as never,
      now,
    );
    expect(bar.secondsLeft).toBe(180);
    expect(bar.done).toBe(10);
  });
});

describe('wp20g: the catalog walk', () => {
  it('records every file once, a changed file as a new version, partial downloads unopened', async () => {
    const dir = tmp();
    const state = initCleanupDatabase(dir);
    if (!state.ok) throw new Error(state.error);
    const db = state.db;
    const root = path.join(dir, 'src');
    fs.mkdirSync(path.join(root, 'a', '_extracted', 'x.zip'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'a', 'one.epub'), 'epub-1');
    fs.writeFileSync(path.join(root, 'a', 'two.azw3'), 'azw');
    fs.writeFileSync(path.join(root, 'a', 'three.epub.!qB'), 'part');
    fs.writeFileSync(path.join(root, 'a', 'song.mp3'), 'mp3');
    fs.writeFileSync(path.join(root, 'a', '_extracted', 'x.zip', 'in.epub'), 'not walked');
    fs.writeFileSync(path.join(root, '.hidden', 'h.epub'), 'not walked');
    const t1 = await walkSource(db, 'p', root);
    expect(t1!.files).toBe(4);
    const rows = () =>
      db
        .prepare('SELECT rel_path, kind, outcome, gone_at FROM calibre_arrival_files ORDER BY id')
        .all() as { rel_path: string; kind: string; outcome: string; gone_at: number | null }[];
    expect(rows().map((r) => [r.rel_path, r.kind, r.outcome])).toEqual(
      [
        ['a/one.epub', 'epub', 'pending'],
        ['a/song.mp3', 'other', 'skipped'],
        ['a/three.epub.!qB', 'partial', 'downloading'],
        ['a/two.azw3', 'book', 'pending'],
      ].sort((x, y) => (x[0] < y[0] ? -1 : 1)) as never,
    );
    // Seen again unchanged: no new row. Changed: a new version, the old one gone.
    await walkSource(db, 'p', root);
    expect(rows()).toHaveLength(4);
    fs.writeFileSync(path.join(root, 'a', 'one.epub'), 'epub-1 changed');
    await walkSource(db, 'p', root);
    const one = rows().filter((r) => r.rel_path === 'a/one.epub');
    expect(one).toHaveLength(2);
    expect(one.filter((r) => r.gone_at === null)).toHaveLength(1);
    // A file that is gone is marked gone; an empty folder (an unmounted share) marks nothing.
    fs.rmSync(path.join(root, 'a', 'song.mp3'));
    await walkSource(db, 'p', root);
    expect(rows().find((r) => r.rel_path === 'a/song.mp3')!.gone_at).not.toBeNull();
    fs.rmSync(path.join(root, 'a'), { recursive: true });
    const t = await walkSource(db, 'p', root);
    expect(t!.errors.join(' ')).toMatch(/empty/);
    expect(rows().filter((r) => r.gone_at === null).length).toBeGreaterThan(0);
    db.close();
  });
});

describe('wp20g: add batches', () => {
  it('hands out one batch, records each step, never hands out an add that was sent', () => {
    const dir = tmp();
    const state = initCleanupDatabase(dir);
    if (!state.ok) throw new Error(state.error);
    const db = state.db;
    const ins = db.prepare(
      `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind, sha256, outcome, facts_json)
       VALUES ('p', ?, 10, 1, 1, 1, 'epub', ?, 'new', '{"title":"T"}')`,
    );
    const f1 = Number(ins.run('a.epub', 'a'.repeat(64)).lastInsertRowid);
    const f2 = Number(ins.run('b.epub', 'b'.repeat(64)).lastInsertRowid);
    const b = new ArrivalBatches(db);
    const [id] = b.planAdds(1, 'L', [f1, f2]);
    const c = b.claim(1000)!;
    expect(c.id).toBe(id);
    expect(c.items.map((i) => i.name)).toEqual(['a.epub', 'b.epub']);
    expect(b.claim(1001)).toBeNull();
    const [i1, i2] = c.items;
    expect(b.fileOf(i1.itemId).fileId).toBe(f1);
    b.report(i1.itemId, { step: 'fetched' }, 1002);
    b.report(i1.itemId, { step: 'adding' }, 1003);
    expect(() => b.fileOf(i1.itemId)).toThrow(/being added/);
    expect(() => b.report(i1.itemId, { step: 'added' }, 1004)).toThrow(/id and uuid/);
    b.report(i1.itemId, { step: 'added', calibreId: 7, uuid: 'u7' }, 1005);
    // An ended item stays as it ended.
    expect(b.report(i1.itemId, { step: 'failed' }, 1006).state).toBe('added');
    b.finish(id, null, 1007);
    expect(b.counts(1)).toEqual({ added: 1, failed: 1 });
    expect(i2.itemId).toBeGreaterThan(0);
    const u = b.planUndo(id, 2000);
    const cu = b.claim(2001)!;
    expect(cu.id).toBe(u);
    expect(cu.kind).toBe('undo_add');
    expect(cu.items.map((i) => i.calibreId)).toEqual([7]);
    db.close();
  });
});

describe('wp20g: a run end to end', () => {
  let env: CleanupEnv;
  let sources: string;
  let src: string;
  const L: Record<string, number> = {};
  const uuidOf = (id: number) =>
    (env.lib.open().prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string })
      .uuid;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let apply: string;
  const A = makeTextEpub({ title: 'A', chapters: chaptersOf(11) });
  const B = makeTextEpub({ title: 'B', chapters: chaptersOf(12) });
  const Bcopy = makeTextEpub({ title: 'B 新装版', chapters: chaptersOf(12) });
  const C = makeTextEpub({ title: 'C', chapters: chaptersOf(13) });
  const D = makeTextEpub({ title: 'D', chapters: chaptersOf(14) });

  const steps = async (max = 200, archives = true) => {
    for (let i = 0; i < max; i++) {
      if (archives) await playArchives();
      const r = await env.service.arrivals.step();
      if (r === 'idle') return;
      if (r === 'wait') {
        const run = env.service.arrivals.currentRun();
        if (run?.p.phase !== 'archives') return;
      }
    }
  };

  /** The linking sidecar's part: list the archive, unpack its EPUB (here, into the temp folder). */
  const playArchives = async () => {
    env.cleanupDb
      .prepare(
        `INSERT INTO link_sidecar_status (id, version, last_seen_at) VALUES (1, '1.4.0', ?)
         ON CONFLICT(id) DO UPDATE SET version = '1.4.0', last_seen_at = excluded.last_seen_at`,
      )
      .run(Date.now());
    for (let i = 0; i < 10; i++) {
      const b = env.service.arrivals.archiveClaim() as {
        id: number;
        kind: string;
        ops: { root: string; dst: string; entry?: { name: string; size: number } | null }[];
      } | null;
      if (!b) return;
      const op = b.ops[0];
      if (b.kind === 'book_list') {
        env.service.arrivals.archiveReport(b.id, [
          {
            id: b.id,
            ok: true,
            entries: [
              { name: 'inner/D.epub', kind: 'file', size: D.length },
              { name: 'inner/notes.pdf', kind: 'file', size: 5 },
              { name: '__MACOSX/._D.epub', kind: 'file', size: 3 },
            ],
            encoding: 'utf8',
          },
        ]);
      } else {
        const out = path.join(sources, op.root, op.dst);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, D);
        const t = fs.statSync(path.join(sources, op.root, 'pack.zip')).mtime;
        fs.utimesSync(out, t, t);
        env.service.arrivals.archiveReport(b.id, [{ id: b.id, ok: true, bytes: D.length }]);
      }
    }
  };

  /** The apply sidecar's part of an add batch, through its routes. */
  const playAdds = async () => {
    for (;;) {
      const claim = await request(env.app)
        .post('/api/v1/cleanup-apply/arrivals/claim')
        .set(auth(apply))
        .send({});
      const batch = claim.body.batch as {
        id: number;
        items: { itemId: number; title: string; sha256: string }[];
      } | null;
      if (!batch) return;
      for (const it of batch.items) {
        const file = await request(env.app)
          .get(`/api/v1/cleanup-apply/arrivals/items/${it.itemId}/file`)
          .set(auth(apply))
          .buffer(true)
          .parse((res, cb) => {
            const parts: Buffer[] = [];
            res.on('data', (c: Buffer) => parts.push(c));
            res.on('end', () => cb(null, Buffer.concat(parts)));
          });
        expect(file.status).toBe(200);
        const bytes = file.body as Buffer;
        expect(sha(bytes)).toBe(it.sha256);
        await request(env.app)
          .post(`/api/v1/cleanup-apply/arrivals/items/${it.itemId}`)
          .set(auth(apply))
          .send({ step: 'fetched' });
        await request(env.app)
          .post(`/api/v1/cleanup-apply/arrivals/items/${it.itemId}`)
          .set(auth(apply))
          .send({ step: 'adding' });
        const id = await env.lib.addBook({ title: it.title, authors: ['作者'], epub: bytes });
        await request(env.app)
          .post(`/api/v1/cleanup-apply/arrivals/items/${it.itemId}`)
          .set(auth(apply))
          .send({ step: 'added', calibreId: id, uuid: uuidOf(id) });
      }
      await request(env.app)
        .post(`/api/v1/cleanup-apply/arrivals/batches/${batch.id}/finish`)
        .set(auth(apply))
        .send({});
    }
  };

  const outcomes = () =>
    Object.fromEntries(
      (
        env.cleanupDb
          .prepare(
            'SELECT rel_path, outcome FROM calibre_arrival_files WHERE gone_at IS NULL ORDER BY rel_path',
          )
          .all() as { rel_path: string; outcome: string }[]
      ).map((r) => [r.rel_path, r.outcome]),
    );

  beforeAll(async () => {
    sources = tmp();
    src = path.join(sources, 'books', 'japanese');
    fs.mkdirSync(path.join(src, 'Discord'), { recursive: true });
    const made = await makeCleanupEnv({
      service: {
        stage3Reader: new InProcessReader(bundle, IMPORT),
        counterBuild: 'test',
        bookSourcesDir: sources,
        bookSourcesReadOnly: false,
      },
    });
    env = made.env;
    L.A = await env.lib.addBook({ title: 'A', authors: ['作者'], epub: A });
    L.B = await env.lib.addBook({ title: 'B', authors: ['作者'], epub: B });
    await made.setup();
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
      .send(healthyHeartbeat())
      .expect(200);
    updateSettings(env.cleanupDb, {
      arrivals: {
        ...getSettings(env.cleanupDb).arrivals,
        pairs: [{ id: 'ja', source: 'books/japanese', libraryId: env.libraryId() }],
        settleMinutes: 0,
        handCheckMinutes: 0,
      },
      ai: { ...getSettings(env.cleanupDb).ai, booksArrivalsDesign: 'E' },
    });
    fs.writeFileSync(path.join(src, 'Discord', 'same-as-A.epub'), A);
    fs.writeFileSync(path.join(src, 'Discord', 'B again.epub'), Bcopy);
    fs.writeFileSync(path.join(src, 'Discord', 'C.epub'), C);
    fs.writeFileSync(path.join(src, 'Discord', 'C copy.epub'), C);
    fs.writeFileSync(path.join(src, 'Discord', 'kindle.azw3'), 'azw3');
    fs.writeFileSync(path.join(src, 'Discord', 'song.mp3'), 'mp3');
    fs.writeFileSync(path.join(src, 'Discord', 'E.epub.!qB'), 'downloading');
    fs.writeFileSync(path.join(src, 'pack.zip'), makeZip([{ name: 'inner/D.epub', data: D }]));
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  it('Preview: checks every file, compares it with the library, adds nothing', async () => {
    env.service.arrivals.setMode('analyse');
    env.service.arrivals.requestRun();
    await steps();
    const o = outcomes();

    if (process.env.WP20G_DEBUG)
      console.log(
        JSON.stringify(
          {
            o,
            run: env.service.arrivals.currentRun(),
            state: env.service.arrivals.state(),
            logs: env.logs.slice(-30),
            runs: env.cleanupDb
              .prepare('SELECT id, state, phase, error FROM calibre_arrival_runs')
              .all(),
          },
          null,
          1,
        ),
      );
    expect(o['Discord/same-as-A.epub']).toBe('identical');
    expect(o['Discord/B again.epub']).toBe('duplicate');
    expect([o['Discord/C.epub'], o['Discord/C copy.epub']].sort()).toEqual(['identical', 'new']);
    expect(o['Discord/kindle.azw3']).toBe('not_imported');
    expect(o['Discord/song.mp3']).toBe('skipped');
    expect(o['Discord/E.epub.!qB']).toBe('downloading');
    expect(o['_extracted/pack.zip/inner/D.epub']).toBe('new');
    expect(o['_extracted/pack.zip/inner/notes.pdf']).toBe('not_imported');
    const identical = env.cleanupDb
      .prepare(
        `SELECT calibre_id FROM calibre_arrival_files WHERE rel_path = 'Discord/same-as-A.epub'`,
      )
      .get() as { calibre_id: number };
    expect(identical.calibre_id).toBe(L.A);
    // Nothing added; the last run's report has the estimate for On.
    expect(
      env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_batches').get(),
    ).toEqual({ n: 0 });
    const last = (await request(env.app).get('/api/v1/cleanup/arrivals').set(auth(env.userToken())))
      .body;
    expect(last.last.state).toBe('done');
    expect(last.last.report.estimate.books).toBe(2);
    expect(last.pairs[0].firstDoneAt).not.toBeNull();
    // The Not imported list as CSV.
    const csv = await request(env.app)
      .get('/api/v1/cleanup/arrivals/not-imported.csv')
      .set(auth(env.userToken()));
    expect(csv.text).toContain('kindle.azw3');
  }, 180_000);

  it('On before the first run is approved adds nothing; after "Add these" it adds the new books', async () => {
    env.service.arrivals.setMode('on');
    env.service.arrivals.requestRun();
    await steps();
    expect(
      env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_batches').get(),
    ).toEqual({ n: 0 });
    const key = 'ja|books/japanese';
    await request(env.app)
      .post('/api/v1/cleanup/arrivals/pairs/approve')
      .set(auth(env.userToken()))
      .send({ key });
    env.service.arrivals.requestRun();
    for (let round = 0; round < 6; round++) {
      await steps();
      await playAdds();
      await env.index();
    }
    const o = outcomes();

    if (process.env.WP20G_DEBUG)
      console.log(
        JSON.stringify(
          {
            o,
            run: env.service.arrivals.currentRun()?.p,
            state: env.service.arrivals.state(),
            logs: env.logs.slice(-20),
            runs: env.cleanupDb
              .prepare('SELECT id, state, phase, error FROM calibre_arrival_runs')
              .all(),
            batches: env.cleanupDb.prepare('SELECT * FROM calibre_arrival_batches').all(),
            items: env.cleanupDb.prepare('SELECT * FROM calibre_arrival_batch_items').all(),
            pairs: env.cleanupDb.prepare('SELECT * FROM calibre_arrival_pairs').all(),
          },
          null,
          1,
        ),
      );
    expect(o['_extracted/pack.zip/inner/D.epub']).toBe('added');
    expect(Object.values(o).filter((x) => x === 'added')).toHaveLength(2);
    // The run's books went through stages 1-3 and stage 2's proposals; its write is a stage-2
    // batch of exactly the run's books (the apply sidecar's stage-2 steps are tested in WP20b).
    const run = env.service.arrivals.currentRun()!;
    expect(run.p.phase).toBe('write2');
    const added = new Set(run.p.scope.import);
    const s2 = env.cleanupDb
      .prepare(
        `SELECT DISTINCT p.calibre_id FROM batch_items i JOIN proposed_changes p ON p.id = i.change_id
         WHERE p.stage = 2 AND p.analysis_id = ?`,
      )
      .all(`arrivals:${run.id}`) as { calibre_id: number }[];
    expect(s2.length).toBeGreaterThan(0);
    for (const r of s2) expect(added.has(r.calibre_id)).toBe(true);
    await request(env.app)
      .post('/api/v1/cleanup/arrivals/stop')
      .set(auth(env.userToken()))
      .expect(200);
    expect(env.service.arrivals.currentRun()).toBeNull();
    // Known books: the import's two.
    expect(
      env.cleanupDb
        .prepare(`SELECT COUNT(*) AS n FROM calibre_known_books WHERE origin = 'import'`)
        .get(),
    ).toEqual({ n: 2 });
  }, 300_000);

  it('a book added by hand that is a copy of a library book is proposed for removal (stage 1)', async () => {
    const H = await env.lib.addBook({ title: 'A (hand)', authors: ['作者'], epub: A });
    await env.index();
    // The run waits out the settle time (0 here), then takes it in.
    env.service.arrivals.setMode('analyse');
    env.service.arrivals.requestRun();
    await steps();
    const p = env.cleanupDb
      .prepare(
        `SELECT calibre_id, analysis_id FROM proposed_changes WHERE stage = 1 AND calibre_id = ? AND analysis_id LIKE 'arrivals:%'`,
      )
      .get(H) as { calibre_id: number; analysis_id: string } | undefined;
    expect(p?.calibre_id).toBe(H);
    expect(
      env.cleanupDb.prepare(`SELECT origin FROM calibre_known_books WHERE calibre_id = ?`).get(H),
    ).toEqual({ origin: 'hand' });
  }, 300_000);

  it('a book you removed from Calibre is never added again', async () => {
    const added = env.cleanupDb
      .prepare(
        `SELECT id, calibre_id, sha256 FROM calibre_arrival_files WHERE outcome = 'added' LIMIT 1`,
      )
      .get() as { id: number; calibre_id: number; sha256: string };
    env.lib.removeBook(added.calibre_id);
    await env.index();
    // The same file under another name arrives later.
    const again = env.cleanupDb
      .prepare('SELECT rel_path FROM calibre_arrival_files WHERE id = ?')
      .get(added.id) as {
      rel_path: string;
    };
    const bytes = fs.readFileSync(path.join(src, again.rel_path));
    fs.writeFileSync(path.join(src, 'Discord', 'renamed copy.epub'), bytes);
    env.service.arrivals.setMode('analyse');
    env.service.arrivals.requestRun();
    await steps();
    const o = outcomes();
    expect(o[again.rel_path]).toBe('removed_by_you');
    expect(o['Discord/renamed copy.epub']).toBe('removed_by_you');
  }, 300_000);
});

describe('wp20g: the queries at the catalog’s end size (lessons 3-4)', () => {
  it('every polled or per-run query reads an index (300,000 files, a year of runs)', async () => {
    const dir = tmp();
    const state = initCleanupDatabase(dir);
    if (!state.ok) throw new Error(state.error);
    const db = state.db;
    const outcomes = [
      'skipped',
      'identical',
      'duplicate',
      'not_imported',
      'added',
      'new',
      'waiting',
    ];
    const ins = db.prepare(
      `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind,
         format, outcome, sha256, calibre_id, calibre_uuid, run_id)
       VALUES (?, ?, ?, 1, 1, 1, 'epub', 'EPUB', ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 300_000; i++) {
        const o = outcomes[i % outcomes.length];
        ins.run(
          i % 3 === 0 ? 'b|books/other' : 'a|books/japanese',
          `f/${i}.epub`,
          1000 + (i % 5000),
          o,
          i % 2 ? i.toString(16).padStart(64, '0') : null,
          o === 'added' ? i : null,
          o === 'added' ? `u${i}` : null,
          1 + (i % 365),
        );
      }
      const run = db.prepare(
        `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json) VALUES ('schedule', 'on', 'done', 'done', ?, '{}')`,
      );
      for (let i = 0; i < 365; i++) run.run(i);
    })();
    db.exec('ANALYZE');
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    const hot: [string, unknown[]][] = [
      // The card's status (polled every 5 s): each folder's counts.
      [
        `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN (?, ?) AND pair_key = ? AND gone_at IS NULL`,
        ['new', 'better', 'a|books/japanese'],
      ],
      // A folded list's page and count.
      [
        `SELECT id FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN (?) AND gone_at IS NULL ORDER BY outcome, pair_key, id LIMIT 25 OFFSET 0`,
        ['not_imported'],
      ],
      // The walk's look-up of a path's latest version (once per file).
      [
        `SELECT id, size, mtime_ms FROM calibre_arrival_files
         WHERE pair_key = ? AND rel_path = ? AND archive_id IS NULL AND gone_at IS NULL ORDER BY id DESC LIMIT 1`,
        ['a|books/japanese', 'f/1.epub'],
      ],
      // identify's next slice, the report, removed-by-you.
      [
        `SELECT id FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN ('pending', 'waiting') AND pair_key IN (?) AND kind = 'epub' AND gone_at IS NULL
           AND NOT (outcome = 'waiting' AND run_id IS ?) ORDER BY id LIMIT 50`,
        ['a|books/japanese', 5],
      ],
      [
        `SELECT outcome, COUNT(*) FROM calibre_arrival_files INDEXED BY calibre_arrival_files_run WHERE run_id = ? GROUP BY outcome`,
        [5],
      ],
      [
        `SELECT id FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome WHERE outcome = 'added'`,
        [],
      ],
      [`SELECT sha256 FROM calibre_arrival_files WHERE sha256 = ?`, ['0'.repeat(64)]],
    ];
    for (const [sql, args] of hot) {
      const p = plan(sql, ...args);
      expect(p, sql).not.toMatch(/SCAN calibre_arrival_files(?! USING)/);
      const t = performance.now();
      db.prepare(sql).all(...args);
      // A list page may count many rows by its index; never seconds (lessons 3).
      expect(performance.now() - t, sql).toBeLessThan(400);
    }
    db.close();
  }, 120_000);
});
