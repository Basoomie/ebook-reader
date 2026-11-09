import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CalibreRoot, copyRealFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

async function realLibraryEnv() {
  const { root, folder } = copyRealFixture();
  const e = makeIndexerEnv(root);
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, folder);
  await e.indexer.tick();
  return { e, libId, auth: { Authorization: `Bearer ${e.token()}` } };
}

describe('catalog API', () => {
  it('requires a per-user token', async () => {
    const { e } = await realLibraryEnv();
    for (const url of ['/api/v1/libraries', '/api/v1/books', '/api/v1/books/x/thumbnail']) {
      const res = await request(e.app).get(url);
      expect(res.status, url).toBe(401);
    }
    const legacy = await request(e.app)
      .get('/api/v1/books')
      .set('Authorization', 'Bearer legacy-token');
    expect(legacy.status).toBe(401);
  });

  it('lists libraries with their index state', async () => {
    const { e, libId, auth } = await realLibraryEnv();
    const res = await request(e.app).get('/api/v1/libraries').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.indexer).toEqual({ enabled: true, error: null });
    expect(res.body.libraries).toHaveLength(1);
    expect(res.body.libraries[0]).toMatchObject({
      id: libId,
      folder: 'japanese-test',
      language: 'ja',
      enabled: true,
      index: { status: 'idle', booksIndexed: 5 },
    });
  });

  it('pages through books newest first', async () => {
    const { e, auth } = await realLibraryEnv();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(e.app)
        .get('/api/v1/books')
        .query(cursor ? { limit: 2, cursor } : { limit: 2 })
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.books.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.books.map((b: { title: string }) => b.title));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([
      '両方ある本',
      '共著の本',
      '薬屋のひとりごと 外伝',
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);

    const [first] = (
      await request(e.app).get('/api/v1/books').query({ limit: 200 }).set(auth)
    ).body.books.slice(-1);
    expect(first).toMatchObject({
      title: '薬屋のひとりごと 1',
      authors: [{ name: '日向夏', sort: '日向夏' }],
      series: { name: '薬屋のひとりごと', index: 1 },
      tags: ['ミステリー', 'ライトノベル'],
      publisher: '主婦の友社',
      charCount: null,
      missing: false,
    });
    expect(first.thumbnail).toMatch(
      /^\/api\/v1\/books\/[0-9a-f-]+\/thumbnail\?v=[0-9a-f]{12}&u=[0-9a-f-]+&s=[\w-]{22}$/,
    );
  });

  it('rejects a bad cursor or limit', async () => {
    const { e, auth } = await realLibraryEnv();
    const bad = await request(e.app).get('/api/v1/books').query({ cursor: 'nope' }).set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cursor');
    const limit = await request(e.app).get('/api/v1/books').query({ limit: 'x' }).set(auth);
    expect(limit.body.error.code).toBe('invalid_limit');
  });

  it('shows one book with its sources and description', async () => {
    const { e, libId, auth } = await realLibraryEnv();
    const list = await request(e.app).get('/api/v1/books').query({ library: libId }).set(auth);
    const id = list.body.books.find((b: { title: string }) => b.title === '薬屋のひとりごと 1').id;
    const res = await request(e.app).get(`/api/v1/books/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('<p>花街の薬屋で働く<b>猫猫</b>の物語。</p>');
    expect(res.body.sources).toEqual([
      {
        kind: 'calibre',
        libraryId: libId,
        calibreUuid: '536add88-1287-44cd-af17-8926c271733c',
        calibreId: 1,
        filePath:
          'Ri Xiang Xia/Yao Wu nohitorigoto 1 (1)/Yao Wu nohitorigoto 1 - Ri Xiang Xia.epub',
        fileSize: 1905,
        missingAt: null,
      },
    ]);
    expect((await request(e.app).get('/api/v1/books/nope').set(auth)).status).toBe(404);
  });

  it('hides missing books unless asked, and books of disabled libraries', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'Stays' });
    const gone = await lib.addBook({ title: 'Goes' });
    const e = makeIndexerEnv(root.dir, { maxMissingPercent: 100 });
    envs.push(e);
    await e.indexer.start({ timer: false });
    const libId = enableLibrary(e.db, 'a');
    await e.indexer.tick();
    lib.removeBook(gone);
    await e.indexer.tick();
    const auth = { Authorization: `Bearer ${e.token()}` };

    const titles = async (query: Record<string, string> = {}) =>
      (await request(e.app).get('/api/v1/books').query(query).set(auth)).body.books.map(
        (b: { title: string; missing: boolean }) => `${b.title}${b.missing ? ' (missing)' : ''}`,
      );
    expect(await titles()).toEqual(['Stays']);
    expect(await titles({ includeMissing: '1' })).toEqual(['Goes (missing)', 'Stays']);

    e.db.prepare('UPDATE libraries SET enabled = 0 WHERE id = ?').run(libId);
    expect(await titles()).toEqual([]);
  });

  it('serves thumbnails with cache headers', async () => {
    const { e, auth } = await realLibraryEnv();
    const list = await request(e.app).get('/api/v1/books').set(auth);
    const book = list.body.books.find((b: { title: string }) => b.title === '両方ある本');
    const url: string = book.thumbnail;

    const res = await request(e.app).get(url).set(auth).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const etag = res.headers.etag;
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/);
    expect(Buffer.from(res.body).subarray(8, 12).toString()).toBe('WEBP');

    const unversioned = await request(e.app).get(url.split('?')[0]).set(auth);
    expect(unversioned.headers['cache-control']).toBe('private, no-cache');

    const cached = await request(e.app).get(url).set(auth).set('If-None-Match', etag);
    expect(cached.status).toBe(304);
  });

  it('answers 404 for books without a cover', async () => {
    const root = new CalibreRoot();
    const lib = root.library('a');
    await lib.addBook({ title: 'Bare', cover: 'none' });
    const e = makeIndexerEnv(root.dir);
    envs.push(e);
    await e.indexer.start({ timer: false });
    enableLibrary(e.db, 'a');
    await e.indexer.tick();
    const auth = { Authorization: `Bearer ${e.token()}` };
    const [book] = (await request(e.app).get('/api/v1/books').set(auth)).body.books;
    expect(book.thumbnail).toBeNull();
    const res = await request(e.app).get(`/api/v1/books/${book.id}/thumbnail`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('no_cover');
  });

  it('reports the indexer as off when it is not configured', async () => {
    const { app, newUserToken } = makeTestApp();
    const auth = { Authorization: `Bearer ${newUserToken()}` };
    const libs = await request(app).get('/api/v1/libraries').set(auth);
    expect(libs.body).toEqual({
      indexer: { enabled: false, error: 'the Calibre indexer is not configured' },
      libraries: [],
    });
    expect((await request(app).get('/api/v1/books').set(auth)).body).toEqual({
      books: [],
      nextCursor: null,
    });
    const thumb = await request(app).get('/api/v1/books/x/thumbnail').set(auth);
    expect(thumb.status).toBe(503);
  });
});
