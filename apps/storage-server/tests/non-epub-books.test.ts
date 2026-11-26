/**
 * Books without an EPUB (non-epub-books.md): the pure rules (what a file is, which file is
 * converted, the twins, the check, the copy decision, the spot check's draw, the sidecar's
 * allowlist) and the whole pass through the real apply sidecar (1.7.0) against the real server,
 * with the stand-in calibredb of the WP20a tests, stand-ins for ebook-convert and calibre-debug
 * (fixtures/formats/fake-formats-tools.cjs) and the reader's real counter bundle: Preview
 * converts, checks and compares without writing; On adds the EPUBs, folds the proven copy into
 * its twin, records the books for the new arrivals; Undo takes all of it back; a book whose write
 * was undone is never selected again.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildArgs, Calibredb, type Login } from '../../cleanup-apply/src/calibredb';
import { CalibredbHelper } from '../../cleanup-apply/src/calibredb-helper';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import {
  convertArgs,
  countedChars,
  decideArchive,
  volumeOfFolder,
} from '../../cleanup-apply/src/formats';
import { Worker } from '../../cleanup-apply/src/worker';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader } from '../src/counts/book-text-worker';
import { judge } from '../src/cleanup/formats/check';
import { decideCopy } from '../src/cleanup/formats/copies';
import { drawSpot } from '../src/cleanup/formats/pass';
import { chooseFile, titleKey, titleNamesSeveralVolumes } from '../src/cleanup/formats/select';
import { DEFAULT_DUPLICATE_SETTINGS } from '../src/cleanup/stage3-rules';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';
import { chaptersOf, makeTextEpub, picture } from './helpers/stage3-fixture';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const FAKE_HELPER = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb-helper.cjs');
const FAKE_TOOLS = path.resolve(__dirname, 'fixtures', 'formats', 'fake-formats-tools.cjs');
const PASSWORD = 'calibre-test-password';
const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;
const quiet = { info: () => {}, error: () => {} };

describe('what a book file is (the sidecar, pure)', () => {
  const e = (...names: string[]) => names.map((name) => ({ name, size: 100 }));
  it('tells the kinds of archive stop 1 found apart', () => {
    expect(decideArchive(e('inner/book.epub', 'cover.jpg'), 'x').kind).toBe('epub-inside');
    expect(decideArchive(e('a.epub', 'b.epub'), 'x').kind).toBe('series');
    expect(decideArchive(e('Horimiya/Vol.07.zip', 'Horimiya/Vol.09.zip'), 'x').kind).toBe('series');
    expect(decideArchive(e('book.azw3'), 'x')).toMatchObject({
      kind: 'book-inside',
      entry: 'book.azw3',
    });
    expect(decideArchive(e('001.jpg', '002.jpg', 'Thumbs.db'), 'x').kind).toBe('images');
    expect(
      decideArchive(e('vol1/001.jpg', 'vol1/002.jpg', 'vol2/001.jpg', 'vol2/002.jpg'), 'x').kind,
    ).toBe('series');
    // mokuro: an EPUB-shaped ZIP of its OCR page (stop 1: よつばと!, Kyo no kioku)
    const mok = decideArchive(
      e('mimetype', 'META-INF/container.xml', '_14 - yotubato!(14).html'),
      '_14 - よつばと!(14) | mokuro',
    );
    expect(mok).toMatchObject({ kind: 'epub-shaped', mokuro: true });
    // mokuro's pictures with their OCR beside them: a picture book
    expect(
      decideArchive(
        e('_ocr/mariko/embed0000.json', 'mariko/001.jpg', 'mariko/002.jpg'),
        'マイ・ブロークン・マリコ',
      ).kind,
    ).toBe('images');
    expect(decideArchive(e('25366/000.mp3', '25366/001.mp3'), '音声').kind).toBe('not-book');
    expect(decideArchive(e('a.pdf', 'b.pdf', 'c.pdf'), 'げんき 1').kind).toBe('pdf-inside');
    expect(
      decideArchive(e('index.html', 'metadata.opf', 'images/1.jpg', 'cover.jpg'), '戯言').kind,
    ).toBe('htmlz');
    expect(
      decideArchive(
        [
          { name: 'fm2a7th0.html', size: 300_000 },
          { name: 'fm2a7th0_files/images/1.jpeg', size: 1 },
        ],
        'N.Y.の弁慶',
      ),
    ).toMatchObject({ kind: 'html', entry: 'fm2a7th0.html' });
    expect(decideArchive(e('a.txt'), 'x').kind).toBe('txt-inside');
    expect(decideArchive(e('a.txt', 'b.txt'), 'x').kind).toBe('text-archive');
    expect(decideArchive([], 'x').kind).toBe('unknown');
    expect(volumeOfFolder('とんがり帽子のアトリエ 第01巻')).toBe(1);
    expect(volumeOfFolder('Otaku_Muzukashi_v01')).toBe(1);
    expect(volumeOfFolder('images')).toBeNull();
  });

  it('runs ebook-convert only inside its work folder', () => {
    const work = path.resolve('/w/ttsu-format-1');
    expect(
      convertArgs('comic', path.join(work, 'in.cbz'), path.join(work, 'out.epub'), work),
    ).toEqual([
      path.join(work, 'in.cbz'),
      path.join(work, 'out.epub'),
      '--no-process',
      '--dont-grayscale',
      '--keep-aspect-ratio',
    ]);
    expect(() =>
      convertArgs('convert', path.resolve('/library/a.azw3'), path.join(work, 'out.epub'), work),
    ).toThrow(/work folder/);
    expect(() =>
      convertArgs('convert', path.join(work, 'a.azw3'), path.join(work, 'out.pdf'), work),
    ).toThrow(/EPUB or a text/);
  });

  it('counts characters the reader way', () => {
    expect(countedChars('今日は、いい天気。 Hello!')).toBe(countedChars('今日はいい天気Hello'));
  });
});

describe('the sidecar allowlist (1.7.0)', () => {
  const login: Login = {
    contentServerUrl: 'http://calibre:8081',
    libraryId: 'japanese-library',
    username: 'u',
    password: 'p',
  };
  it('adds exactly one checked EPUB or one quarantined copy file, never replacing', () => {
    expect(
      buildArgs('add_format', login, [
        '--dont-replace',
        '12',
        '/tmp/ttsu-formats/ttsu-format-item-5/book.epub',
      ]),
    ).toEqual([
      'add_format',
      '--with-library',
      'http://calibre:8081/#japanese-library',
      '--username',
      'u',
      '--password',
      '<stdin>',
      '--dont-replace',
      '12',
      '/tmp/ttsu-formats/ttsu-format-item-5/book.epub',
    ]);
    expect(
      buildArgs('add_format', login, [
        '--dont-replace',
        '12',
        '/quarantine/0b6c4a8e-1111-4222-8333-444455556666/77/book.azw3',
      ]).slice(-1),
    ).toEqual(['/quarantine/0b6c4a8e-1111-4222-8333-444455556666/77/book.azw3']);
    expect(() =>
      buildArgs('add_format', login, ['12', '/tmp/ttsu-format-item-5/book.epub']),
    ).toThrow();
    expect(() =>
      buildArgs('add_format', login, ['--dont-replace', '12', '/library/x/book.epub']),
    ).toThrow(/item's EPUB or a quarantined/);
    expect(() =>
      buildArgs('add_format', login, ['--dont-replace', '12', '/tmp/ttsu-format-item-5/book.pdf']),
    ).toThrow();
    expect(() =>
      buildArgs('add_format', login, ['--dont-replace', '1,2', '/tmp/ttsu-format-item-5/b.epub']),
    ).toThrow();
  });
  it('removes exactly one allowed format of one book', () => {
    expect(buildArgs('remove_format', login, ['12', 'EPUB']).slice(-2)).toEqual(['12', 'EPUB']);
    expect(buildArgs('remove_format', login, ['12', 'AZW3']).slice(-2)).toEqual(['12', 'AZW3']);
    expect(() => buildArgs('remove_format', login, ['12', 'PDF'])).toThrow();
    expect(() => buildArgs('remove_format', login, ['12', 'EPUB', 'AZW3'])).toThrow();
    expect(() => buildArgs('remove_format', login, ['12', 'EPUB', '--permanent'])).toThrow();
  });
});

describe('the pass rules (server, pure)', () => {
  it('chooses the file to convert, or why a book is listed', () => {
    const f = (...formats: string[]) => formats.map((format) => ({ format, name: 'b', size: 1 }));
    expect(chooseFile({ title: 'x', formats: f('PDF', 'MOBI') })).toMatchObject({
      file: { format: 'MOBI' },
    });
    expect(chooseFile({ title: 'x', formats: f('CBZ', 'AZW3') })).toMatchObject({
      file: { format: 'AZW3' },
    });
    expect(chooseFile({ title: 'x', formats: [] })).toEqual({ listed: 'no_file' });
    expect(chooseFile({ title: 'x', formats: f('PDF') })).toEqual({ listed: 'pdf' });
    expect(chooseFile({ title: 'x', formats: f('KFX') })).toEqual({ listed: 'kfx' });
    expect(chooseFile({ title: 'Horimiya 第01-10巻', formats: f('ZIP') })).toEqual({
      listed: 'series',
    });
    // A range in a Kindle book's title is no series archive.
    expect(chooseFile({ title: '本 1-2', formats: f('AZW3') })).toMatchObject({ file: {} });
    expect(titleNamesSeveralVolumes('侵略!イカ娘 1-22 (with mokuro)')).toBe(true);
    expect(titleNamesSeveralVolumes('Wotakoi [vol 01-08]')).toBe(true);
    expect(titleNamesSeveralVolumes('ゆらぎ荘の幽奈さん カラー版 20')).toBe(false);
    expect(titleKey('物語【電子特典付き】 (文庫)')).toBe(titleKey('物語'));
  });

  it('checks an EPUB: opens, keeps its text, keeps every page', () => {
    const facts = {
      outcome: 'converted',
      kind: 'plain',
      method: 'convert',
      detail: null,
      sourceSize: 1,
      sourceSha256: 'a',
      sourceChars: 100_000,
      epubChars: 99_990,
      sourceImages: null,
      epubSha256: 'b',
      epubSize: 1,
      ms: 1,
      entries: null,
    };
    const s = { textKeptMin: 0.97, pictureMaxChars: 1000 };
    const m = { opened: true, openError: null, readerChars: 90_000, epubImages: 3 };
    expect(judge(facts, m, s).ok).toBe(true);
    expect(judge({ ...facts, epubChars: 90_000 }, m, s)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Text lost/),
    });
    expect(
      judge(facts, { ...m, opened: false, openError: 'item toc.ncx not found' }, s),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/toc\.ncx/) });
    const pic = { ...facts, method: 'comic', kind: 'images', sourceChars: null, sourceImages: 6 };
    expect(judge(pic, { ...m, epubImages: 7 }, s).ok).toBe(true);
    expect(judge(pic, { ...m, epubImages: 4 }, s)).toMatchObject({
      ok: false,
      reason: 'Pages missing: 4 pictures in the EPUB, 6 in the archive',
    });
  });

  it('folds only a proven copy (same text both ways at 95 %, or wholly inside)', () => {
    const t = (copyInTwin: number, twinInCopy: number) => ({
      twinId: 2,
      twinUuid: 'u2',
      twinTitle: '物語',
      copyInTwin,
      twinInCopy,
      error: null,
    });
    const d = (m: ReturnType<typeof t>[]) =>
      decideCopy('物語', 50_000, m, DEFAULT_DUPLICATE_SETTINGS, 0.95).verdict;
    expect(d([t(0.999, 0.998)])).toBe('fold');
    // お兄ちゃんだけど愛さえあれば関係ないよねっ at 93-95 %: review, not folded
    expect(d([t(0.94, 0.93)])).toBe('near');
    expect(
      decideCopy('物語', 50_000, [t(0.97, 0.6)], DEFAULT_DUPLICATE_SETTINGS, 0.95),
    ).toMatchObject({ verdict: 'fold', how: 'inside' });
    expect(d([t(0.68, 0.7)])).toBe('near');
    expect(d([t(0.02, 0.01)])).toBe('convert');
    expect(d([])).toBe('convert');
    // A picture book is not compared by text.
    expect(decideCopy('画集', 10, [t(1, 1)], DEFAULT_DUPLICATE_SETTINGS, 0.95).verdict).toBe(
      'convert',
    );
    // A free preview never folds into the full book.
    expect(
      decideCopy('物語【試し読み】', 50_000, [t(1, 0.2)], DEFAULT_DUPLICATE_SETTINGS, 0.95).verdict,
    ).not.toBe('fold');
  });

  it('draws the spot check in proportion to the kinds, at least one of each', () => {
    const books = [
      ...Array.from({ length: 80 }, (_, i) => ({ uuid: `t${i}`, group: 'text' })),
      ...Array.from({ length: 18 }, (_, i) => ({ uuid: `p${i}`, group: 'picture' })),
      { uuid: 'r0', group: 'rebuilt' },
      { uuid: 'e0', group: 'extracted' },
    ];
    const pick = drawSpot(books, 30, (u) => u);
    expect(pick).toHaveLength(30);
    const by = (g: string) => pick.filter((b) => b.group === g).length;
    expect(by('rebuilt')).toBe(1);
    expect(by('extracted')).toBe(1);
    expect(by('picture')).toBeGreaterThanOrEqual(5);
    expect(by('text')).toBeGreaterThanOrEqual(22);
  });
});

describe('the pass through the real sidecar', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let formatTmp: string;
  let comicEpub: string;
  let toolsLog: string;
  let calibreLog: string;
  let user: string;
  let apply: string;
  let ids: Record<string, number>;
  const helpers: CalibredbHelper[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const listen = (s: http.Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );
  const meta = <T>(sql: string, ...p: unknown[]): T[] => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return db.prepare(sql).all(...p) as T[];
    } finally {
      db.close();
    }
  };
  const formatsOf = (id: number) =>
    meta<{ format: string }>('SELECT format FROM data WHERE book = ? ORDER BY format', id).map(
      (r) => r.format,
    );
  const tagsOf = (id: number) =>
    meta<{ name: string }>(
      'SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ?',
      id,
    ).map((r) => r.name);
  /** Writes a book's non-EPUB file with these bytes (the fixture writes "x"). */
  const setFile = (id: number, format: string, data: Buffer) => {
    fs.writeFileSync(
      path.join(env.lib.bookDir(id), `Book ${id} - Author ${id}.${format.toLowerCase()}`),
      data,
    );
    env.lib.exec((db) =>
      db
        .prepare('UPDATE data SET uncompressed_size = ? WHERE book = ? AND format = ?')
        .run(data.length, id, format),
    );
  };

  beforeEach(async () => {
    const made = await makeCleanupEnv({
      leaseSeconds: 60,
      service: { stage3Reader: new InProcessReader(bundle, IMPORT), counterBuild: 'test' },
    });
    env = made.env;
    const pics = [await picture(1, 400, 40), await picture(2, 400, 50), await picture(3, 400, 60)];
    const same = makeTextEpub({ title: '物語', chapters: chaptersOf(1) });
    ids = {
      T1: await env.lib.addBook({ title: '物語', authors: ['作者'], epub: same }),
      C1: await env.lib.addBook({
        title: '物語',
        authors: ['作者'],
        formats: ['AZW3'],
        tags: ['TMW-collection-1'],
      }),
      T2: await env.lib.addBook({
        title: '別の本',
        epub: makeTextEpub({ title: '別の本', chapters: chaptersOf(4) }),
      }),
      D1: await env.lib.addBook({ title: '別の本', formats: ['AZW3'] }),
      U1: await env.lib.addBook({ title: '独自の本', formats: ['AZW3'] }),
      R1: await env.lib.addBook({ title: 'ロックされた本', formats: ['AZW3'] }),
      P1: await env.lib.addBook({ title: '画集', formats: ['CBZ'] }),
      Z1: await env.lib.addBook({ title: '中身', formats: ['ZIP'] }),
      F1: await env.lib.addBook({ title: 'PDFの本', formats: ['PDF'] }),
      N1: await env.lib.addBook({ title: '空の記録', formats: [] }),
      S1: await env.lib.addBook({ title: '全集 1-3', formats: ['CBZ'] }),
    };
    setFile(ids.C1, 'AZW3', same);
    setFile(ids.D1, 'AZW3', makeTextEpub({ title: '別の本', chapters: chaptersOf(2) }));
    setFile(ids.U1, 'AZW3', makeTextEpub({ title: '独自の本', chapters: chaptersOf(3) }));
    setFile(ids.R1, 'AZW3', Buffer.from('DRM locked bytes'));
    setFile(ids.P1, 'CBZ', makeZip(pics.map((data, i) => ({ name: `00${i + 1}.jpg`, data }))));
    setFile(
      ids.Z1,
      'ZIP',
      makeZip([
        { name: 'inner/中身.epub', data: makeTextEpub({ title: '中身', chapters: chaptersOf(5) }) },
      ]),
    );
    setFile(ids.S1, 'CBZ', makeZip([{ name: '001.jpg', data: pics[0] }]));
    await made.setup();
    await env.index();
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    (env as unknown as { url: string }).url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    formatTmp = makeTempDir('formats');
    toolsLog = path.join(makeTempDir('toolslog'), 'tools.log');
    calibreLog = path.join(makeTempDir('calibrelog'), 'calibre.log');
    comicEpub = path.join(makeTempDir('comic'), 'comic.epub');
    fs.writeFileSync(
      comicEpub,
      makeTextEpub({ title: '画集', chapters: ['絵'], images: pics, noToc: true }),
    );
    user = env.userToken();
    apply = env.applyToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        pacing: { itemDelaySeconds: 0, batchSize: 500, maxBatchPercent: 10 },
      })
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

  function worker(extra: { addFormatTimeout?: 'after' } = {}) {
    const config = {
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
      writeWaitSeconds: 3,
      formatTmpDir: formatTmp,
    } as SidecarConfig;
    const fakeEnv = {
      FAKE_CALIBRE_LIBRARY: env.lib.dir,
      FAKE_PASSWORD: PASSWORD,
      FAKE_LOG: calibreLog,
      FAKE_ILLUSTRATOR: '1',
      FAKE_ADD_FORMAT_TIMEOUT: extra.addFormatTimeout ?? '',
    };
    const helper = new CalibredbHelper({
      program: process.execPath,
      args: [FAKE_HELPER],
      startTimeoutMs: 10_000,
      env: { ...fakeEnv, TTSU_EXPORT_DIRS: `${quarantine}:${formatTmp}` },
    });
    helpers.push(helper);
    process.env.FAKE_COMIC_EPUB = comicEpub;
    process.env.FAKE_TOOLS_LOG = toolsLog;
    return new Worker({
      config,
      log: process.env.NEP_DEBUG ? { info: console.log, error: console.error } : quiet,
      retryMinMs: 10,
      retryMaxMs: 50,
      calibredb: new Calibredb({
        program: process.execPath,
        prefixArgs: [FAKE],
        timeoutMs: 60_000,
        env: fakeEnv,
        helper,
      }),
      formatPrograms: {
        ebookConvert: process.execPath,
        calibreDebug: process.execPath,
        helperScript: '-',
        prefixArgs: [FAKE_TOOLS],
      },
    });
  }

  /** Steps the pass and the sidecar until the pass reaches `phase` (or gives up). */
  async function runUntil(w: Worker, phase: string, max = 200) {
    for (let i = 0; i < max; i++) {
      const st = env.service.formats.state();
      if (st.progress.phase === phase) return;
      const r = await env.service.formats.step();
      if (process.env.NEP_DEBUG) console.log('step', i, st.progress.phase, r);
      if (r === 'idle' || r === 'wait') {
        await w.cycle();
        env.service.batches.checkIngested();
      }
    }
    const b = env.service.formats.batchesOf()[0];
    throw new Error(
      `The pass never reached ${phase}: ${JSON.stringify(env.service.formats.state().progress)} ` +
        `batch ${JSON.stringify(b)} items ${JSON.stringify(b ? env.service.batches.items(b.id) : [])} ` +
        `logs ${env.logs.slice(-15).join(' | ')}`,
    );
  }

  it('Preview converts, checks and compares without writing; On writes; Undo takes it back', async () => {
    const w = worker();
    await request(env.app)
      .put('/api/v1/cleanup/formats/mode')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    await runUntil(w, 'spot');
    await env.service.formats.step();
    const lib = env.libraryId();
    const rows = Object.fromEntries(
      (
        env.cleanupDb
          .prepare('SELECT calibre_id, state, listed_reason, verdict FROM calibre_format_books')
          .all() as {
          calibre_id: number;
          state: string;
          listed_reason: string | null;
          verdict: string | null;
        }[]
      ).map((r) => [r.calibre_id, r]),
    );
    expect(rows[ids.F1]).toMatchObject({ state: 'listed', listed_reason: 'pdf' });
    expect(rows[ids.N1]).toMatchObject({ state: 'listed', listed_reason: 'no_file' });
    expect(rows[ids.S1]).toMatchObject({ state: 'listed', listed_reason: 'series' });
    expect(rows[ids.R1]).toMatchObject({ state: 'listed', listed_reason: 'drm' });
    expect(rows[ids.C1]).toMatchObject({ state: 'proposed', verdict: 'fold' });
    for (const k of ['D1', 'U1', 'P1', 'Z1'])
      expect(rows[ids[k]], k).toMatchObject({ state: 'proposed', verdict: 'convert' });
    // Nothing was written to Calibre in Preview: only reads (list, export).
    const calls = fs.readFileSync(calibreLog, 'utf8');
    expect(calls).not.toMatch(/add_format|remove_format|"remove"|set_metadata/);
    expect(formatsOf(ids.U1)).toEqual(['AZW3']);
    // The tools ran only inside the sidecar's own folder, and its job folders are gone.
    for (const line of fs.readFileSync(toolsLog, 'utf8').trim().split('\n')) {
      const args = JSON.parse(line) as string[];
      for (const a of args.filter((x) => path.isAbsolute(x) && x !== '-'))
        expect(path.resolve(a).startsWith(path.resolve(formatTmp))).toBe(true);
    }
    expect(fs.readdirSync(formatTmp)).toEqual([]);
    // The spot check: the four converted books, all marked right; then On.
    const spot = await request(env.app)
      .get('/api/v1/cleanup/formats/spot')
      .set(auth(user))
      .expect(200);
    expect(spot.body.books).toHaveLength(4);
    await request(env.app)
      .put('/api/v1/cleanup/formats/mode')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(409);
    for (const b of spot.body.books)
      await request(env.app)
        .put(`/api/v1/cleanup/formats/spot/${b.uuid}`)
        .set(auth(user))
        .send({ verdict: 'right' })
        .expect(200);
    const epub = await request(env.app)
      .get(`/api/v1/cleanup/formats/epub/${spot.body.books[0].uuid}`)
      .set(auth(user))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((epub.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await request(env.app)
      .put('/api/v1/cleanup/formats/mode')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(200);
    await runUntil(w, 'done');
    // Each converted book has its EPUB beside its original file.
    for (const [k, orig] of [
      ['D1', 'AZW3'],
      ['U1', 'AZW3'],
      ['P1', 'CBZ'],
      ['Z1', 'ZIP'],
    ] as const)
      expect(formatsOf(ids[k]), k).toEqual([orig, 'EPUB'].sort());
    // The proven copy is folded into its twin: its file and its own tag there, the copy gone.
    expect(formatsOf(ids.T1)).toEqual(['AZW3', 'EPUB']);
    expect(tagsOf(ids.T1)).toContain('TMW-collection-1');
    expect(meta('SELECT id FROM books WHERE id = ?', ids.C1)).toHaveLength(0);
    // The new arrivals take the converted books in as books added by hand.
    const known = env.cleanupDb
      .prepare(
        `SELECT calibre_id FROM calibre_known_books WHERE origin = 'format' ORDER BY calibre_id`,
      )
      .all() as { calibre_id: number }[];
    expect(known.map((r) => r.calibre_id)).toEqual(
      [ids.D1, ids.U1, ids.P1, ids.Z1].sort((a, b) => a - b),
    );
    // Every stored EPUB is the checked one, and the server's copies are gone.
    for (let i = 0; i < 10 && (await env.service.batches.formats.verifyStored()); i++);
    const stored = env.cleanupDb
      .prepare('SELECT state, COUNT(*) AS n FROM calibre_format_store GROUP BY state')
      .all();
    expect(stored).toEqual([{ state: 'same', n: 4 }]);
    // The reader takes them in at its next index.
    await env.index();
    expect(
      env.readerBook(meta<{ uuid: string }>('SELECT uuid FROM books WHERE id = ?', ids.U1)[0].uuid),
    ).toMatchObject({ missing: false });

    // Undo: the EPUBs come off, the copy comes back, its file and tag come off the twin.
    const batches = env.service.formats.batchesOf();
    expect(batches).toHaveLength(1);
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batches[0].id}/undo`)
      .set(auth(user))
      .expect(200);
    for (let i = 0; i < 10 && env.service.batches.open(); i++) await w.cycle();
    expect(env.service.batches.open()).toBeNull();
    expect(formatsOf(ids.U1)).toEqual(['AZW3']);
    expect(formatsOf(ids.P1)).toEqual(['CBZ']);
    expect(formatsOf(ids.C1)).toEqual(['AZW3']);
    expect(formatsOf(ids.T1)).toEqual(['EPUB']);
    expect(tagsOf(ids.T1)).not.toContain('TMW-collection-1');
    expect(
      env.cleanupDb
        .prepare(`SELECT COUNT(*) AS n FROM calibre_known_books WHERE origin = 'format'`)
        .get(),
    ).toEqual({ n: 0 });
    // Never again: looking again from the start leaves the undone books alone.
    await request(env.app).post('/api/v1/cleanup/formats/again').set(auth(user)).expect(200);
    await env.service.formats.step();
    const again = env.cleanupDb
      .prepare('SELECT calibre_id FROM calibre_format_books WHERE run = 2')
      .all() as { calibre_id: number }[];
    expect(again.map((r) => r.calibre_id)).not.toContain(ids.U1);
    expect(again.map((r) => r.calibre_id)).not.toContain(ids.C1);
    expect(again.map((r) => r.calibre_id)).toContain(ids.F1);
    void lib;
  }, 300_000);

  it('an add_format that times out but happened is never sent twice', async () => {
    const w = worker({ addFormatTimeout: 'after' });
    await request(env.app)
      .put('/api/v1/cleanup/formats/mode')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    await runUntil(w, 'spot');
    await env.service.formats.step();
    for (const b of env.service.formats.spotList()) env.service.formats.setVerdict(b.uuid, 'right');
    env.service.formats.setMode('on');
    await runUntil(w, 'done');
    expect(formatsOf(ids.U1)).toEqual(['AZW3', 'EPUB']);
    const adds = fs
      .readFileSync(calibreLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"add_format"') && l.includes(`"${ids.U1}"`));
    expect(adds).toHaveLength(1);
  }, 300_000);
});
