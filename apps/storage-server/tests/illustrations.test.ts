/**
 * Season 2 §6: the book page's illustrations for a book the device doesn't store
 * (catalog/illustrations.ts, api/illustration-routes.ts). The list is made by the counter
 * bundle's `illustrationsForServer` in a child process; pictures are read from the EPUB
 * (originals) or made into webp thumbnails, cached under CACHE_DIR/illustrations only.
 * The fixture (tests/fixtures/illustrations/illustrated.epub) is written by
 * apps/web/tests/fixtures/build-illustrated-epub.ts.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { IllustrationItem, ListReader } from '../src/catalog/illustrations';
import { ZipFile } from '../src/migration/zip-read';
import { readEntryBytes } from '../src/uploads/epub-meta';
import { CalibreRoot, fingerprint } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const FIXTURE = path.join(__dirname, 'fixtures', 'illustrations', 'illustrated.epub');
const EPUB = fs.readFileSync(FIXTURE);

/** What the rule keeps from the fixture (the web test checks the same list). */
const EXPECTED = [
  {
    entry: 'OEBPS/images/kuchie1.png',
    beforeToc: true,
    width: 800,
    height: 1200,
    rgb: [220, 120, 60],
  },
  {
    entry: 'OEBPS/images/kuchie2.png',
    beforeToc: true,
    width: 1200,
    height: 800,
    rgb: [60, 160, 90],
  },
  {
    entry: 'OEBPS/images/ill1.png',
    beforeToc: false,
    width: 700,
    height: 1000,
    rgb: [200, 40, 40],
  },
  { entry: 'OEBPS/images/ill2.png', beforeToc: false, width: 640, height: 960, rgb: [40, 40, 200] },
  {
    entry: 'OEBPS/images/ill3.png',
    beforeToc: false,
    width: 720,
    height: 1080,
    rgb: [200, 200, 40],
  },
];

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

async function env(options: { read?: ListReader; uploads?: boolean; titles?: string[] } = {}) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const titles = options.titles ?? ['挿絵の本'];
  const calibreIds: number[] = [];
  for (const title of titles) {
    const id = await lib.addBook({ title, cover: 'none' });
    lib.replaceEpub(id, EPUB);
    calibreIds.push(id);
  }
  const e = makeIndexerEnv(
    root.dir,
    { maxMissingPercent: 100 },
    {},
    {},
    {
      uploads: options.uploads,
      illustrationsRead: options.read,
    },
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const auth = { Authorization: `Bearer ${e.token()}` };
  const books = (await request(e.app).get('/api/v1/books').set(auth)).body.books as {
    id: string;
    title: string;
  }[];
  const idOf = (title: string) => books.find((b) => b.title === title)!.id;
  return { e, root, lib, libId, calibreIds, auth, idOf };
}

interface ListItem {
  n: number;
  width: number | null;
  height: number | null;
  beforeToc: boolean;
  thumbUrl: string;
  url: string;
}

/** Asks for the list until it is no longer being prepared. */
async function listOf(e: IndexerEnv, auth: object, id: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(e.app).get(`/api/v1/books/${id}/illustrations`).set(auth);
    if (res.status !== 202) return res;
    expect(res.body).toEqual({ status: 'preparing' });
    if (Date.now() > until) throw new Error('the list was never ready');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const entryBytes = async (entry: string) => {
  const opener = (f: string) => fsp.open(f, 'r');
  const zip = await ZipFile.open(FIXTURE, opener);
  const info = zip.get(entry)!;
  await zip.close();
  return readEntryBytes(FIXTURE, opener, info, 1 << 25);
};

/** A fast stand-in for the child process, counting its runs. */
function standIn(
  items: IllustrationItem[] = EXPECTED.map(({ rgb: _rgb, ...i }) => ({
    key: i.entry.slice(6),
    ...i,
  })),
) {
  const calls: string[] = [];
  const read: ListReader = async (file) => {
    calls.push(file);
    return { version: 1, items };
  };
  return { calls, read };
}

describe('illustrations of a Calibre book (the real child process)', () => {
  it('lists the pictures in book order and serves thumbnails and originals by signed URL, read-only', async () => {
    const { e, root, auth, idOf } = await env();
    const before = fingerprint(root.dir);
    const id = idOf('挿絵の本');
    const res = await listOf(e, auth, id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const items = res.body.items as ListItem[];
    expect(res.body.status).toBe('ready');
    expect(
      items.map(({ n, width, height, beforeToc }) => ({ n, width, height, beforeToc })),
    ).toEqual(
      EXPECTED.map((x, n) => ({ n, width: x.width, height: x.height, beforeToc: x.beforeToc })),
    );

    for (const [n, item] of items.entries()) {
      // No token: the signature alone opens it (a plain <img>).
      const thumb = await request(e.app).get(item.thumbUrl);
      expect(thumb.status).toBe(200);
      expect(thumb.headers['content-type']).toBe('image/webp');
      expect(thumb.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      const meta = await sharp(thumb.body as Buffer).metadata();
      expect(meta.height).toBe(360);
      expect(meta.width).toBe(Math.round((360 * EXPECTED[n].width) / EXPECTED[n].height));
      const { channels } = await sharp(thumb.body as Buffer).stats();
      const rgb = channels.slice(0, 3).map((c) => Math.round(c.mean));
      rgb.forEach((v, i) => expect(Math.abs(v - EXPECTED[n].rgb[i])).toBeLessThanOrEqual(3));

      const full = await request(e.app).get(item.url).buffer(true);
      expect(full.status).toBe(200);
      expect(full.headers['content-type']).toBe('image/png');
      expect(full.headers['x-content-type-options']).toBe('nosniff');
      expect(full.headers['content-security-policy']).toContain("default-src 'none'");
      expect(Buffer.compare(full.body as Buffer, await entryBytes(EXPECTED[n].entry))).toBe(0);
    }

    // Written only under CACHE_DIR/illustrations; the library is untouched.
    expect(fingerprint(root.dir)).toEqual(before);
    const cache = path.join(e.calibre.cacheDir, 'illustrations', id.slice(0, 2), id);
    const [version] = fs.readdirSync(cache);
    expect(fs.readdirSync(path.join(cache, version)).sort()).toEqual(
      ['list.json', 't0.webp', 't1.webp', 't2.webp', 't3.webp', 't4.webp'].sort(),
    );
  }, 120_000);

  it('a damaged EPUB answers failed with the reason, and is not read again', async () => {
    const { e, lib, calibreIds, auth, idOf } = await env();
    lib.replaceEpub(calibreIds[0], Buffer.from('not a zip file at all'));
    const id = idOf('挿絵の本');
    const res = await listOf(e, auth, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toMatch(/could not be read/);
    const again = await request(e.app).get(`/api/v1/books/${id}/illustrations`).set(auth);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
  }, 120_000);
});

describe('illustrations: cache, versions and access', () => {
  it('reads a book once; a changed file gets a new list, a metadata edit does not', async () => {
    const { calls, read } = standIn();
    const { e, lib, calibreIds, auth, idOf } = await env({ read });
    const id = idOf('挿絵の本');
    const first = await listOf(e, auth, id);
    expect(first.body.items).toHaveLength(5);
    await listOf(e, auth, id);
    expect(calls).toHaveLength(1);

    // A metadata edit (Calibre's last_modified): same file, same list.
    lib.exec((db) =>
      db
        .prepare('UPDATE books SET last_modified = ? WHERE id = ?')
        .run('2030-01-01 00:00:00+00:00', calibreIds[0]),
    );
    await e.indexer.tick();
    const edited = await listOf(e, auth, id);
    expect(edited.body.items[0].url).toBe(first.body.items[0].url);
    expect(calls).toHaveLength(1);

    // A replaced file: the old list's pictures answer 409 until the list is asked again.
    lib.replaceEpub(calibreIds[0], Buffer.concat([EPUB, Buffer.from('trailing bytes')]));
    const old = first.body.items[2] as ListItem;
    const changed = await request(e.app).get(old.url);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('changed');
    const fresh = await listOf(e, auth, id);
    expect(calls).toHaveLength(2);
    expect(fresh.body.items[2].url).not.toBe(old.url);
    // The book's earlier list is gone: its addresses are out of date.
    expect((await request(e.app).get(old.thumbUrl)).status).toBe(404);
    const cache = path.join(e.calibre.cacheDir, 'illustrations', id.slice(0, 2), id);
    expect(fs.readdirSync(cache)).toHaveLength(1);
  });

  it('a signature opens only its own book; the token opens without one', async () => {
    const { read } = standIn();
    const { e, auth, idOf } = await env({ read, titles: ['One', 'Two'] });
    const one = (await listOf(e, auth, idOf('One'))).body.items[0] as ListItem;
    await listOf(e, auth, idOf('Two'));
    const forged = one.url.replace(idOf('One'), idOf('Two'));
    expect((await request(e.app).get(forged)).status).toBe(401);
    const badSig = one.url.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAA');
    expect((await request(e.app).get(badSig)).status).toBe(401);
    const bare = one.url.replace(/\?.*$/, '');
    expect((await request(e.app).get(bare)).status).toBe(401);
    expect((await request(e.app).get(bare).set(auth)).status).toBe(200);
    // The list itself needs the token.
    expect((await request(e.app).get(`/api/v1/books/${idOf('One')}/illustrations`)).status).toBe(
      401,
    );
  });

  it('unknown, removed and file-less books; an unknown picture or version', async () => {
    const { read, calls } = standIn();
    const { e, root, lib, calibreIds, auth, idOf } = await env({ read, titles: ['Stays', 'Goes'] });
    const stays = idOf('Stays');
    const goes = idOf('Goes');
    const item = (await listOf(e, auth, stays)).body.items[0] as ListItem;
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (await request(e.app).get(`/api/v1/books/${unknown}/illustrations`).set(auth)).status,
    ).toBe(404);
    lib.removeBook(calibreIds[1]);
    await e.indexer.tick();
    const removed = await request(e.app).get(`/api/v1/books/${goes}/illustrations`).set(auth);
    expect(removed.status).toBe(410);
    expect(removed.body.error.code).toBe('missing');
    expect((await request(e.app).get(item.url.replace('/0/full', '/9/full'))).status).toBe(404);
    // The signature covers the version: another version is refused by it (401), and with
    // the token an unknown version is out of date (404).
    const otherVersion = item.url.replace(
      /illustrations\/[0-9a-f]{16}/,
      'illustrations/0123456789abcdef',
    );
    expect((await request(e.app).get(otherVersion)).status).toBe(401);
    const stale = await request(e.app).get(otherVersion).set(auth);
    expect(stale.status).toBe(404);
    expect(stale.body.error.code).toBe('stale');
    const detail = await request(e.app).get(`/api/v1/books/${stays}`).set(auth);
    fs.rmSync(path.join(root.dir, 'a', ...detail.body.sources[0].filePath.split('/')));
    const gone = await request(e.app).get(`/api/v1/books/${stays}/illustrations`).set(auth);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('file_missing');
    expect(calls).toHaveLength(1);
  });

  it('an uploaded book is read from the upload store', async () => {
    const { calls, read } = standIn();
    const { e, libId, auth } = await env({ read, uploads: true, titles: [] });
    const staged = await request(e.app)
      .post('/api/v1/uploads')
      .query({ library: libId, name: 'illustrated.epub' })
      .set(auth)
      .set('Content-Type', 'application/epub+zip')
      .send(EPUB);
    expect(staged.status).toBe(201);
    const added = await request(e.app)
      .post(`/api/v1/uploads/${staged.body.uploadId}/add`)
      .set(auth);
    expect(added.status).toBe(201);
    const id = added.body.book.id as string;
    const list = await listOf(e, auth, id);
    expect(list.body.items).toHaveLength(5);
    expect(calls[0].startsWith(path.join(e.config.dataRoot, '.uploads'))).toBe(true);
    const full = await request(e.app)
      .get((list.body.items[1] as ListItem).url)
      .buffer(true);
    expect(full.status).toBe(200);
    expect(Buffer.compare(full.body as Buffer, await entryBytes(EXPECTED[1].entry))).toBe(0);
  });
});
