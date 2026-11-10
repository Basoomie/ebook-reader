/**
 * WP7b: uploads. Staging, the duplicate check (same file, fingerprint, title and
 * author), adding and discarding, uploaded books everywhere in the catalog (lists,
 * lookup, groups, cards, search, file, thumbnail, counts), and the folders: files only
 * under DATA_DIR/.uploads, Calibre untouched, the old sync's listing unaware.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { listLegacyFolders } from '../src/migration/legacy-fs';
import { CalibreRoot, fingerprint, makeJpeg, type FixtureBook } from './helpers/calibre-fixture';
import { image, makeEpub, makeZip } from './helpers/epub-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

interface UploadSpec {
  title: string;
  authors?: string[];
  series?: { name: string; index: number };
  cover?: Buffer;
  images?: Record<string, Buffer>;
  spine?: string[];
  /** Extra entries (a "rewritten" copy differs in bytes but not in fingerprint). */
  extra?: { name: string; data: string }[];
}

function makeUploadEpub(spec: UploadSpec): Buffer {
  const spine = spec.spine ?? ['ch1', 'ch2'];
  const images = spec.images ?? {};
  const items = [
    ...spine.map(
      (id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
    ...Object.keys(images).map(
      (href, i) => `<item id="img${i}" href="${href}" media-type="image/jpeg"/>`,
    ),
    ...(spec.cover
      ? ['<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>']
      : []),
  ];
  const metas = spec.series
    ? `<meta name="calibre:series" content="${spec.series.name}"/><meta name="calibre:series_index" content="${spec.series.index}"/>`
    : '';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${spec.title}</dc:title>
    ${(spec.authors ?? []).map((a) => `<dc:creator opf:role="aut">${a}</dc:creator>`).join('')}
    ${metas}
  </metadata>
  <manifest>${items.join('')}</manifest>
  <spine>${spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine>
</package>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      deflate: true,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    ...spine.map((id) => ({
      name: `OEBPS/${id}.xhtml`,
      data: `<html><body><p>${id} ${spec.title}</p></body></html>`,
      deflate: true,
    })),
    ...Object.entries(images).map(([href, data]) => ({ name: `OEBPS/${href}`, data })),
    ...(spec.cover ? [{ name: 'OEBPS/cover.jpg', data: spec.cover }] : []),
    ...(spec.extra ?? []),
  ]);
}

async function setup(books: FixtureBook[], opts: { counterFile?: string; maxMb?: number } = {}) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  for (const b of books) await lib.addBook({ cover: 'none', ...b });
  const e = makeIndexerEnv(
    root.dir,
    {},
    opts.maxMb === undefined ? {} : { uploads: { maxMb: opts.maxMb, stagedHours: 24 } },
    opts.counterFile
      ? { config: { background: true, timeoutSeconds: 60 }, counterFile: opts.counterFile }
      : {},
    { uploads: true },
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  return { e, root, lib, libId, auth: { Authorization: `Bearer ${e.token()}` } };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function stage(s: Setup, body: Buffer, name = 'book.epub', library = s.libId) {
  return request(s.e.app)
    .post('/api/v1/uploads')
    .query({ library, name })
    .set(s.auth)
    .set('Content-Type', 'application/epub+zip')
    .send(body);
}

async function upload(s: Setup, body: Buffer, name?: string) {
  const res = await stage(s, body, name);
  expect(res.status).toBe(201);
  return res.body as {
    uploadId: string;
    title: string;
    authors: string[];
    series: { name: string; index: number | null } | null;
    duplicates: { match: string; book: { id: string; title: string; source: string } }[];
  };
}

async function add(s: Setup, uploadId: string) {
  const res = await request(s.e.app).post(`/api/v1/uploads/${uploadId}/add`).set(s.auth);
  expect(res.status).toBe(201);
  return res.body.book as {
    id: string;
    title: string;
    source: string;
    authors: { name: string }[];
    series: { name: string; index: number | null } | null;
    thumbnail: string | null;
    libraryId: string;
  };
}

function staged(s: Setup): string[] {
  return fs.readdirSync(path.join(s.e.config.dataRoot, '.uploads', 'staging'));
}

const EXISTING: FixtureBook = {
  title: '既存の本',
  authors: ['著者一'],
  epub: makeEpub({ title: '既存の本', images: { 'img/a.jpg': image(1) }, spine: ['p1', 'p2'] }),
};

describe('uploads: adding a book', () => {
  it('adds an upload as its own book that shows up everywhere, with files only in .uploads', async () => {
    const s = await setup([EXISTING]);
    const calibreBefore = fingerprint(s.root.dir);
    // Nothing is created in DATA_DIR until the first upload.
    expect(fs.readdirSync(s.e.config.dataRoot)).toEqual([]);
    const cover = await makeJpeg(200);
    const epub = makeUploadEpub({
      title: '新しい本',
      authors: ['著者二', '著者三'],
      series: { name: '新シリーズ', index: 2 },
      cover,
    });
    const staging = await upload(s, epub, '新しい本.epub');
    expect(staging).toMatchObject({
      title: '新しい本',
      authors: ['著者二', '著者三'],
      series: { name: '新シリーズ', index: 2 },
      duplicates: [],
    });
    expect(staged(s)).toEqual([`${staging.uploadId}.epub`]);

    const book = await add(s, staging.uploadId);
    expect(book).toMatchObject({
      title: '新しい本',
      source: 'upload',
      libraryId: s.libId,
      authors: [{ name: '著者二' }, { name: '著者三' }],
      series: { name: '新シリーズ', index: 2 },
    });
    expect(staged(s)).toEqual([]);

    // Lists: newest first, both kinds, the badge source on each.
    const list = await request(s.e.app).get('/api/v1/books').set(s.auth);
    expect(
      list.body.books.map((b: { title: string; source: string }) => [b.title, b.source]),
    ).toEqual([
      ['新しい本', 'upload'],
      ['既存の本', 'calibre'],
    ]);
    const detail = await request(s.e.app).get(`/api/v1/books/${book.id}`).set(s.auth);
    expect(detail.body.sources).toEqual([
      expect.objectContaining({
        kind: 'upload',
        calibreUuid: null,
        filePath: `books/${book.id}/book.epub`,
      }),
    ]);
    const lookup = await request(s.e.app)
      .post('/api/v1/books/lookup')
      .set(s.auth)
      .send({ ids: [book.id] });
    expect(lookup.body.books.map((b: { id: string }) => b.id)).toEqual([book.id]);
    const search = await request(s.e.app)
      .get('/api/v1/books')
      .query({ q: 'author:著者三' })
      .set(s.auth);
    expect(search.body.books.map((b: { id: string }) => b.id)).toEqual([book.id]);
    const series = await request(s.e.app)
      .get('/api/v1/books')
      .query({ by: 'series', group: '新シリーズ' })
      .set(s.auth);
    expect(series.body.books.map((b: { id: string }) => b.id)).toEqual([book.id]);
    const authors = await request(s.e.app)
      .get('/api/v1/groups')
      .query({ by: 'author' })
      .set(s.auth);
    expect(authors.body.groups.map((g: { name: string }) => g.name)).toEqual(
      expect.arrayContaining(['著者一', '著者二', '著者三']),
    );
    const cards = await request(s.e.app).get('/api/v1/collections/cards').set(s.auth);
    const unread = cards.body.cards.find((c: { id: string }) => c.id === 'unread');
    expect(unread.bookCount).toBe(2);
    const libs = await request(s.e.app).get('/api/v1/libraries').set(s.auth);
    expect(libs.body.uploads).toEqual({ enabled: true, maxBytes: 200 * 1024 * 1024 });

    // The file and the thumbnail made from the EPUB's own cover.
    const file = await request(s.e.app)
      .get(`/api/v1/books/${book.id}/file`)
      .set(s.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, epub)).toBe(0);
    expect(file.headers.etag).toMatch(/^"upload-[0-9a-f]{64}"$/);
    expect(book.thumbnail).toBeTruthy();
    const thumb = await request(s.e.app).get(book.thumbnail!);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');

    // Folders: Calibre byte-identical; DATA_DIR has only .uploads/books/<id>/book.epub.
    expect(fingerprint(s.root.dir)).toEqual(calibreBefore);
    const data = s.e.config.dataRoot;
    expect(fs.readdirSync(data)).toEqual(['.uploads']);
    expect(fs.readdirSync(path.join(data, '.uploads', 'books'))).toEqual([book.id]);
    expect(fs.readdirSync(path.join(data, '.uploads', 'books', book.id))).toEqual(['book.epub']);
    // The migration scan (and the old sync's listing rules) never see it.
    expect(await listLegacyFolders(data)).toEqual([]);

    // A re-index of the library leaves the upload alone (never flagged missing).
    await s.lib.addBook({ title: '後から', cover: 'none' });
    s.lib.age();
    s.e.db.prepare('UPDATE library_index_state SET reindex_requested_at = ?').run(Date.now());
    await s.e.indexer.tick();
    const after = await request(s.e.app).get(`/api/v1/books/${book.id}`).set(s.auth);
    expect(after.body.missing).toBe(false);
    // Exactly one source per book.
    expect(
      s.e.db.prepare('SELECT book_id FROM book_sources GROUP BY book_id HAVING COUNT(*) > 1').all(),
    ).toEqual([]);
  });

  it('is idempotent; discarding an added upload is refused; a discarded one is gone', async () => {
    const s = await setup([]);
    const one = await upload(s, makeUploadEpub({ title: 'A' }));
    const first = await add(s, one.uploadId);
    expect((await add(s, one.uploadId)).id).toBe(first.id);
    const discardAdded = await request(s.e.app)
      .delete(`/api/v1/uploads/${one.uploadId}`)
      .set(s.auth);
    expect(discardAdded.status).toBe(409);
    expect(discardAdded.body.error.code).toBe('already_added');

    const two = await upload(s, makeUploadEpub({ title: 'B' }));
    const del = await request(s.e.app).delete(`/api/v1/uploads/${two.uploadId}`).set(s.auth);
    expect(del.status).toBe(204);
    expect(staged(s)).toEqual([]);
    const late = await request(s.e.app).post(`/api/v1/uploads/${two.uploadId}/add`).set(s.auth);
    expect(late.status).toBe(404);
    expect(late.body.error.code).toBe('upload_expired');
    const count = s.e.db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('uploads: duplicate check', () => {
  const imgs = { 'img/x.jpg': image(7), 'img/y.jpg': image(8) };

  it('finds the same file', async () => {
    const s = await setup([]);
    const epub = makeUploadEpub({ title: 'Same', authors: ['X'] });
    const first = await add(s, (await upload(s, epub)).uploadId);
    const again = await upload(s, epub);
    expect(again.duplicates).toEqual([
      { match: 'same-file', book: expect.objectContaining({ id: first.id, source: 'upload' }) },
    ]);
  });

  it('finds a Calibre copy by fingerprint although its bytes differ (Calibre rewrote it)', async () => {
    const calibreCopy = makeUploadEpub({
      title: '同じ本',
      authors: ['別名義'],
      images: imgs,
      spine: ['a', 'b', 'c'],
      extra: [{ name: 'META-INF/calibre_bookmarks.txt', data: 'calibre' }],
    });
    const s = await setup([{ title: '同じ本', authors: ['著者一'], epub: calibreCopy }]);
    const mine = makeUploadEpub({
      title: '同じ本',
      authors: ['別人'],
      images: imgs,
      spine: ['a', 'b', 'c'],
    });
    expect(Buffer.compare(mine, calibreCopy)).not.toBe(0);
    const res = await upload(s, mine);
    expect(res.duplicates).toEqual([
      {
        match: 'fingerprint',
        book: expect.objectContaining({ title: '同じ本', source: 'calibre' }),
      },
    ]);
  });

  it('falls back to title and author, and reports nothing for a different author', async () => {
    const s = await setup([
      {
        title: '題名 1',
        authors: ['著者 一'],
        epub: makeUploadEpub({ title: '題名 1', images: { 'i.jpg': image(1) } }),
      },
    ]);
    // Different images (fingerprint fails), same title and author (spacing differs).
    const hit = await upload(
      s,
      makeUploadEpub({ title: '題名1', authors: ['著者一'], images: { 'i.jpg': image(2) } }),
    );
    expect(hit.duplicates).toEqual([
      { match: 'title-author', book: expect.objectContaining({ title: '題名 1' }) },
    ]);
    const miss = await upload(
      s,
      makeUploadEpub({ title: '題名 1', authors: ['別の著者'], images: { 'i.jpg': image(3) } }),
    );
    expect(miss.duplicates).toEqual([]);
    // Nothing was merged or added by the check.
    const count = s.e.db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('uploads: refusals and clean-up', () => {
  it('refuses a damaged file, a missing or switched-off library and a too large file', async () => {
    const s = await setup([], { maxMb: 1 });
    const bad = await stage(s, Buffer.from('not a zip at all, sorry'));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('bad_epub');
    expect(staged(s)).toEqual([]);

    const unknown = await stage(s, makeUploadEpub({ title: 'X' }), 'x.epub', 'no-such-library');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('library_not_found');

    const big = await stage(s, Buffer.alloc(2 * 1024 * 1024, 1));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('too_large');
    expect(staged(s)).toEqual([]);

    s.e.db.prepare('UPDATE libraries SET enabled = 0').run();
    const off = await stage(s, makeUploadEpub({ title: 'X' }));
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('library_disabled');
  });

  it('removes staged files nobody decided on after UPLOAD_STAGED_HOURS', async () => {
    const s = await setup([]);
    const one = await upload(s, makeUploadEpub({ title: 'Waiting' }));
    expect(await s.e.uploads!.sweep()).toBe(0);
    expect(await s.e.uploads!.sweep(Date.now() + 25 * 3600_000)).toBe(1);
    expect(staged(s)).toEqual([]);
    const late = await request(s.e.app).post(`/api/v1/uploads/${one.uploadId}/add`).set(s.auth);
    expect(late.body.error.code).toBe('upload_expired');
  });

  it('counts an uploaded book with the background counter', async () => {
    const counter = path.join(makeTempDir('counter'), 'size-count.cjs');
    fs.writeFileSync(
      counter,
      `/*
 * epub-count-version: 1
 * build: 00000000fa4ec0de
 */
exports.EPUB_COUNT_VERSION = 1;
exports.countEpubForServer = async (blob) => ({ characters: blob.size });
`,
    );
    const s = await setup([], { counterFile: counter });
    const epub = makeUploadEpub({ title: 'Counted' });
    const book = await add(s, (await upload(s, epub)).uploadId);
    await s.e.counts.idle();
    const res = await request(s.e.app).get(`/api/v1/books/${book.id}`).set(s.auth);
    expect(res.body).toMatchObject({ charCount: epub.length, charCountStatus: 'counted' });
  });

  it('is not mounted when the upload adapter is off', async () => {
    const t = makeTestApp();
    const res = await request(t.app)
      .post('/api/v1/uploads')
      .query({ library: 'x' })
      .set('Authorization', `Bearer ${t.newUserToken()}`)
      .send(Buffer.from('x'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    const libs = await request(t.app)
      .get('/api/v1/libraries')
      .set('Authorization', `Bearer ${t.newUserToken()}`);
    expect(libs.body.uploads).toEqual({ enabled: false, maxBytes: 0 });
  });
});
